import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

extension GatewayProcessManagerTests {
    @Test(.testWaitLimit, arguments: ["::1", "my host"], [false, true])
    func `invalid custom bind preserves recovery intent`(host: String, wasActive: Bool) async throws {
        let port = AppProfile.current.defaultGatewayPort
        try await self.withLaunchAgentEnvironment(port: port) {
            let manager = GatewayProcessManager()
            let app = AppStateStore.shared
            let previousMode = app.connectionMode
            let previousPause = app.isPaused
            app.connectionMode = .local
            app.isPaused = false
            defer {
                app.connectionMode = previousMode
                app.isPaused = previousPause
            }
            let store = GatewayEndpointStore.shared
            await store.setLocalUnavailableReason(nil)
            let configURL = OpenClawPaths.configURL
            func config(_ host: String) throws -> Data {
                try JSONSerialization.data(withJSONObject: [
                    "gateway": [
                        "mode": "local", "port": port, "bind": "custom", "customBindHost": host,
                    ],
                ])
            }
            let invalid = try config(host)
            let corrected = try config("127.0.0.2")
            try invalid.write(to: configURL, options: .atomic)
            manager.desiredActive = wasActive

            func retireFixture() async {
                let startup = manager.gatewayStartTask
                manager._testResetGatewayStartTask()
                await startup?.value
                await manager.waitForStartupAttempt()
                await store.setLocalUnavailableReason(nil)
            }

            do {
                manager.setActive(true, source: wasActive ? .recovery : .request)
                await manager.waitForStartupAttempt()
                #expect(manager.desiredActive)
                #expect(manager.lastFailureReason?.contains("gateway.customBindHost") == true)
                #expect(manager.gatewayStartTask == nil)
                await store.refresh()
                guard case let .unavailable(.local, reason, _) = await store.currentState() else {
                    Issue.record("Invalid activation must expose the local configuration error")
                    await retireFixture()
                    return
                }
                #expect(reason.contains("gateway.customBindHost"))
                await #expect(throws: Error.self) { _ = try await store.requireEndpoint() }
                try #expect(Data(contentsOf: configURL) == invalid)

                try corrected.write(to: configURL, options: .atomic)
                await store.refresh()
                let endpoint = try await store.requireEndpoint()
                #expect(endpoint.config.url.absoluteString == "ws://127.0.0.2:\(port)")
                manager.setActive(true, source: .recovery)
                #expect(manager.desiredActive)
                #expect(manager.status == .starting)
                #expect(manager.gatewayStartTask != nil)
                // Accept the real startup decision, but do not launch a service from this fixture.
                let startup = manager.gatewayStartTask
                manager._testResetGatewayStartTask()
                await startup?.value
                try await TestWait.observed("activation environment check") {
                    manager.environmentStatus.kind != .checking
                }
                try #expect(Data(contentsOf: configURL) == corrected)
                #expect(!GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                    .contains { $0.first == "install" })
                await retireFixture()
            } catch {
                await retireFixture()
                throw error
            }
        }
    }

    @Test(.testWaitLimit)
    func `companion port conflict still blocks background recovery`() async throws {
        let port = AppProfile.current.defaultGatewayPort
        try await self.withLaunchAgentEnvironment(mode: "remote", port: port) {
            let manager = GatewayProcessManager()
            let app = AppStateStore.shared
            let previousCompanion = app.hostsLocalGatewayWithRemotePrimary
            let previousMode = app.connectionMode
            app.hostsLocalGatewayWithRemotePrimary = true
            defer {
                app.hostsLocalGatewayWithRemotePrimary = previousCompanion
                app.connectionMode = previousMode
            }
            let configURL = OpenClawPaths.configURL
            let config = try JSONSerialization.data(withJSONObject: [
                "gateway": [
                    "mode": "remote", "port": port,
                    "remote": ["transport": "direct", "url": "ws://127.0.0.1:\(port)"],
                ],
            ])
            try config.write(to: configURL, options: .atomic)
            manager.setActive(true)
            #expect(!manager.desiredActive)
            #expect(manager.lastFailureReason?.contains("also used by the remote primary") == true)
            let failure = manager.status
            manager.setActive(true, source: .recovery)
            #expect(!manager.desiredActive)
            #expect(manager.status == failure)
            #expect(manager.gatewayStartTask == nil)
            try #expect(Data(contentsOf: configURL) == config)

            // A remote primary does not project local unavailability. Observe the
            // queued conflict on a local fixture before clearing it, so it cannot
            // publish into another test after this scope releases its environment.
            let local = try JSONSerialization.data(withJSONObject: [
                "gateway": ["mode": "local", "port": port],
            ])
            try local.write(to: configURL, options: .atomic)
            app.connectionMode = .local
            let store = GatewayEndpointStore.shared
            var published = false
            for await state in await store.subscribe() {
                if case let .unavailable(.local, reason, _) = state, reason == manager.lastFailureReason {
                    published = true
                    break
                }
            }
            #expect(published)
            await store.setLocalUnavailableReason(nil)
        }
    }
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { applyBoardFixtureOps } from "../../test-helpers/board-fixture.tsx";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import "./board-view.tsx";
import {
  boardWidget,
  gatewayContext,
  mount,
  settleCells,
  snapshot,
} from "./board-view.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("openclaw-board-view retention", () => {
  it("prepares only the adjacent report tab and adopts its hidden cards on selection", async () => {
    const report = (name: string, tabId: string) =>
      boardWidget({ name, tabId, contentKind: "plugin", pluginKind: "session:report" });
    const view = await mount({
      snapshot: snapshot({
        tabs: [
          ...snapshot().tabs,
          { tabId: "later", title: "Later", position: 2, chatDock: "right" },
        ],
        widgets: [boardWidget(), report("next-report", "ops"), report("later-report", "later")],
      }),
    });
    expect(view.querySelectorAll("openclaw-board-widget-cell")).toHaveLength(1);
    await vi.waitFor(
      () => expect(view.querySelectorAll("openclaw-board-widget-cell")).toHaveLength(2),
      { timeout: 2000 },
    );
    const prepared = [...view.querySelectorAll("openclaw-board-widget-cell")].find(
      (cell) => cell.widget?.name === "next-report",
    )!;
    expect(prepared.hidden).toBe(true);
    expect(prepared.active).toBe(false);
    expect(prepared.querySelector("openclaw-report-widget")).toBeNull();
    view.activeTabId = "ops";
    await settleCells(view);
    expect(prepared.hidden).toBe(false);
    expect(prepared.active).toBe(true);
    expect(prepared.isConnected).toBe(true);
    await vi.waitFor(
      () => expect(view.querySelectorAll("openclaw-board-widget-cell")).toHaveLength(3),
      { timeout: 2000 },
    );
    const later = [...view.querySelectorAll("openclaw-board-widget-cell")].find(
      (cell) => cell.widget?.name === "later-report",
    )!;
    view.activeTabId = "main";
    await settleCells(view);
    expect(later.isConnected).toBe(true);
    expect(later.hidden).toBe(true);
    view.activeTabId = "ops";
    await settleCells(view);
    // A visited card moved to an unvisited tab still has its original lifetime.
    view.snapshot = {
      ...view.snapshot!,
      widgets: view.snapshot!.widgets.map((widget) =>
        widget.name === "next-report" ? { ...widget, tabId: "later" } : widget,
      ),
    };
    await settleCells(view);
    view.snapshot = { ...view.snapshot!, revision: 2 };
    await settleCells(view);
    expect(prepared.isConnected).toBe(true);
    view.remove();
  });

  it("keeps active and retained frames quiet for unrelated Gateway publications", async () => {
    const context = gatewayContext(null);
    const listeners = new Set<Parameters<typeof context.gateway.subscribe>[0]>();
    context.gateway.subscribe = (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    };
    const view = await mount({ context });
    view.activeTabId = "ops";
    await settleCells(view);
    const cells = [...view.querySelectorAll("openclaw-board-widget-cell")];
    const frames = cells.map((cell) => cell.querySelector("iframe")!);
    expect(frames).toHaveLength(3);
    const messages = frames.map((frame) => vi.spyOn(frame.contentWindow!, "postMessage"));
    const publish = async () => {
      for (const notify of listeners) {
        notify(context.gateway.snapshot);
      }
      await settleCells(view);
    };
    for (let index = 0; index < 10; index += 1) {
      context.gateway.snapshot.usagePublications = {
        main: { usageUpdatedAt: index + 1, committedAt: index + 1 },
      };
      await publish();
    }
    expect(messages.map((message) => message.mock.calls.length)).toEqual([0, 0, 0]);
    expect(cells.map((cell) => cell.querySelector("iframe"))).toEqual(frames);

    const gateway = context.gateway.snapshot;
    const hello = gatewayHelloForMethods([], ["operator.read"]);
    const transitions: Array<[string, () => void]> = [
      ["restart", () => (gateway.restartPending = true)],
      ["restart settled", () => (gateway.restartPending = false)],
      ["suspension", () => (gateway.suspensionPhase = "draining")],
      ["accepting", () => (gateway.suspensionPhase = "accepting")],
      ["client", () => (gateway.client = createTestGatewayClient(async () => ({})))],
      [
        "hello/auth/recovery",
        () =>
          (gateway.hello = {
            ...hello,
            auth: { ...hello.auth, recoveryScope: "new-principal" },
          }),
      ],
      ["credentials/account", () => Object.assign(context.gateway, { connectionRevision: 1 })],
      ["disconnect", () => (gateway.phase = "reconnecting")],
      ["reconnect", () => (gateway.phase = "connected")],
    ];
    for (const [label, change] of transitions) {
      messages.forEach((message) => message.mockClear());
      change();
      await publish();
      expect(messages[2]!.mock.calls.length, label).toBeGreaterThan(0);
      expect(messages[0], label).not.toHaveBeenCalled();
      expect(messages[1], label).not.toHaveBeenCalled();
      expect(
        cells.map((cell) => cell.querySelector("iframe")),
        label,
      ).toEqual(frames);
    }
    view.activeTabId = "main";
    await settleCells(view);
    expect(messages[0]).toHaveBeenCalled();
    expect(messages[1]).toHaveBeenCalled();
    view.remove();
    await Promise.resolve();
    expect(listeners.size).toBe(0);
  });

  it("preserves each widget cell and iframe identity when order changes", async () => {
    const view = await mount();
    const before = [...view.querySelectorAll("openclaw-board-widget-cell")].find(
      (cell) => cell.widget?.name === "alpha",
    );
    const frame = before?.querySelector("iframe");
    const card = before!.querySelector<HTMLElement>(".board-widget")!;
    expect(card.style.gridColumn).toBe("1 / span 6");
    expect(card.style.gridRow).toBe("1 / span 4");
    const removedNodes: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        removedNodes.push(...record.removedNodes);
      }
    });
    observer.observe(view.querySelector(".board-grid")!, { childList: true });
    const reordered = snapshot();
    reordered.widgets[0]!.position = 1;
    reordered.widgets[1]!.position = 0;
    view.snapshot = reordered;
    const cells = await settleCells(view);
    const after = cells.find((cell) => cell.widget?.name === "alpha");
    expect(after).toBe(before);
    expect(after?.querySelector("iframe")).toBe(frame);
    expect(card.style.gridColumn).toBe("7 / span 6");
    expect(card.style.gridRow).toBe("1 / span 4");
    expect(removedNodes).not.toContain(before);
    expect(after?.querySelector(".board-widget")?.getAttribute("aria-posinset")).toBe("2");
    expect(
      cells
        .find((cell) => cell.widget?.name === "beta")
        ?.querySelector(".board-widget")
        ?.getAttribute("aria-posinset"),
    ).toBe("1");
    observer.disconnect();

    view.snapshot = applyBoardFixtureOps(view.snapshot!, [
      { kind: "widget_resize", name: "alpha", sizeW: 12, sizeH: 6, heightMode: "fixed" },
    ]);
    await settleCells(view);
    expect(card.style.gridColumn).toBe("1 / span 12");
    expect(card.style.gridRow).toBe("5 / span 6");
    view.activeTabId = "ops";
    await settleCells(view);
    view.activeTabId = "main";
    await settleCells(view);
    expect(card.style.gridColumn).toBe("1 / span 12");
    expect(card.style.gridRow).toBe("5 / span 6");
    expect(before!.hidden).toBe(false);
    expect(before!.querySelector("iframe")).toBe(frame);

    view.snapshot = { ...snapshot(), sessionKey: "agent:main:other-session" };
    const sessionCells = await settleCells(view);
    const afterSessionChange = sessionCells.find((cell) => cell.widget?.name === "alpha");
    expect(afterSessionChange).not.toBe(before);
    expect(afterSessionChange?.querySelector("iframe")).not.toBe(frame);
  });

  it("refreshes retained widgets and releases removed tabs without mounting unvisited tabs", async () => {
    const view = await mount({ widgetFrameUrl: (name, revision) => `/${name}/${revision}` });
    const first = view.querySelector("openclaw-board-widget-cell")!;
    const frame = first.querySelector("iframe");
    expect(view.querySelectorAll("openclaw-board-widget-cell")).toHaveLength(2);
    view.activeTabId = "ops";
    await settleCells(view);
    const updated = snapshot({ revision: 2 });
    updated.widgets[0]!.revision = 3;
    view.snapshot = updated;
    await settleCells(view);
    expect(first.querySelector("iframe")).toBe(frame);
    expect(frame?.getAttribute("src")).toBe("/alpha/3");
    view.snapshot = {
      ...view.snapshot,
      tabs: view.snapshot.tabs.filter((tab) => tab.tabId !== "main"),
    };
    const remaining = await settleCells(view);
    expect(first.isConnected).toBe(false);
    expect(remaining.map((cell) => cell.widget?.name)).toEqual(["ops-only"]);
  });

  it("retires cached documents when the exact agent owner changes", async () => {
    const view = await mount();
    view.session = { agentId: "first-agent", sessionKey: "shared-display-key" };
    const previous = await settleCells(view);
    view.activeTabId = "ops";
    await settleCells(view);
    view.session = { agentId: "second-agent", sessionKey: "shared-display-key" };
    const current = await settleCells(view);
    expect(previous.every((cell) => !cell.isConnected)).toBe(true);
    expect(current.map((cell) => cell.widget?.name)).toEqual(["ops-only"]);
  });

  it("keeps a replacement widget lazy after its mounted namesake is deleted", async () => {
    const view = await mount();
    const cell = view.querySelector("openclaw-board-widget-cell")!;
    const original = cell.widget!;
    view.snapshot = applyBoardFixtureOps(view.snapshot!, [
      { kind: "widget_remove", name: original.name },
    ]);
    await settleCells(view);
    expect(cell.isConnected).toBe(false);

    view.snapshot = {
      ...view.snapshot,
      widgets: [...view.snapshot.widgets, { ...original, tabId: "ops" }],
    };
    const cells = await settleCells(view);
    expect(cells.some((entry) => entry.widget?.name === original.name)).toBe(false);
    view.activeTabId = "ops";
    const replacement = (await settleCells(view)).find(
      (entry) => entry.widget?.name === original.name,
    );
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(cell);
  });

  it("keeps a removed MCP cell connected with its last binding until teardown settles", async () => {
    const widget = boardWidget({ contentKind: "mcp-app" });
    const view = await mount({ snapshot: snapshot({ widgets: [widget] }) });
    const cell = view.querySelector("openclaw-board-widget-cell")!;
    const teardown = createDeferred();
    vi.spyOn(cell, "teardown").mockReturnValue(teardown.promise);

    view.snapshot = snapshot({ revision: 2, widgets: [] });
    await settleCells(view);
    expect(cell).toMatchObject({ isConnected: true, active: false, hidden: true });
    expect(cell.widget).toBe(widget);

    teardown.resolve();
    await settleCells(view);
    expect(cell.isConnected).toBe(false);
  });

  it("tears down its retained cells when removed before disposal", async () => {
    const view = await mount();
    const cells = [...view.querySelectorAll("openclaw-board-widget-cell")];
    const teardown = cells.map((cell) => vi.spyOn(cell, "teardown"));
    view.remove();
    const retired = view.teardown();
    expect(teardown.every((spy) => spy.mock.calls.length === 1)).toBe(true);
    await retired;
  });
});

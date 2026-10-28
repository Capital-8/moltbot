import { beforeEach, expect, it, vi } from "vitest";
import {
  nativeCommandAuthFixture,
  prepareAuthFixture,
} from "../runtime-plan/prepare-auth.test-support.js";
import { resolveHarnessAuthProfileSelection } from "./attempt-auth-selection.js";

const mocks = vi.hoisted(() => ({ store: vi.fn() }));
// mock-isolation: Exercise command selection without reading operator credential storage.
vi.mock("../auth-profiles/store-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth-profiles/store-runtime.js")>()),
  ensureAuthProfileStoreAsync: mocks.store,
}));
const { params, provider } = nativeCommandAuthFixture();
beforeEach(() => {
  mocks.store.mockReset().mockResolvedValue(params.authProfileStore);
});

it.each([
  ["native-command", undefined, undefined],
  ["native-command", "auto", undefined],
  ["native-command", "user", "user"],
  ["api-key", undefined, "auto"],
] as const)(
  "selects %s with %s pin before auth preparation",
  async (auth, source, expectedSource) => {
    const selected = await resolveHarnessAuthProfileSelection({
      ...params,
      config: { models: { providers: { autodev: { ...provider, auth } } } },
      agentDir: "/fixture",
      workspaceDir: "/fixture/workspace",
      authProfileProvider: params.provider,
      allowHarnessAuthProfileForwarding: true,
      ...(source ? { sessionAuthProfileId: "openai:decoy", sessionAuthProfileSource: source } : {}),
    });
    expect(selected.authProfileId).toBe(expectedSource ? "openai:decoy" : undefined);
    expect(selected.authProfileIdSource).toBe(expectedSource);
    expect(selected.authProfileProvider).toBe(expectedSource ? "openai" : params.provider);
    if (auth === "native-command") {
      const prepare = () =>
        prepareAuthFixture({ ...params, sessionAuthProfileId: selected.authProfileId });
      if (source === "user") {
        expect(prepare).toThrow("auth profile binding");
      } else {
        expect(mocks.store).not.toHaveBeenCalled();
        expect(prepare().plan.credentialSource).toEqual({ kind: "none" });
      }
    }
  },
);

import { describe, expect, it, vi } from "vitest";
import { createToolHandoffSettlement } from "./tool-handoff-settlement.js";

describe("command tool handoff settlement", () => {
  it("retains receipts before custody and invokes registered cleanup only once", async () => {
    const owner = createToolHandoffSettlement();
    const cleanup = vi.fn(async (assertCurrent: () => void) => assertCurrent());
    owner.register(cleanup);
    expect(cleanup).not.toHaveBeenCalled();
    const assertCurrent = vi.fn();
    await owner.settle(assertCurrent);
    await owner.settle(assertCurrent);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(assertCurrent);
    expect(() => owner.register(cleanup)).toThrow("already settled");
  });

  it("does not clear after authority revocation and permits retry of a failed cleanup", async () => {
    const owner = createToolHandoffSettlement();
    const cleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("storage offline"))
      .mockResolvedValue(undefined);
    owner.register(cleanup);
    await expect(
      owner.settle(() => {
        throw new Error("revoked");
      }),
    ).rejects.toThrow("revoked");
    expect(cleanup).not.toHaveBeenCalled();
    await expect(owner.settle(() => {})).rejects.toThrow("storage offline");
    await owner.settle(() => {});
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
});

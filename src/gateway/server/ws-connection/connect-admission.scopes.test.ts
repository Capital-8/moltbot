import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { expect, it } from "vitest";
import { resolveEffectiveConnectionScopes } from "./connect-admission.js";

it("attenuates verified role write authority to read on a read-capped device-less connection", () => {
  const upgradeReq = new IncomingMessage(new Socket());
  upgradeReq.headers["x-openclaw-scopes"] = "operator.read";
  const input = {
    role: "operator",
    deviceScopes: [],
    verifiedIdentity: "github:example.ghe.com:101",
    upgradeReq,
  };
  expect(resolveEffectiveConnectionScopes({ ...input, verifiedIdentityWrite: true })).toEqual([
    "operator.read",
  ]);
  expect(resolveEffectiveConnectionScopes({ ...input, verifiedIdentityWrite: false })).toEqual([]);
  expect(
    resolveEffectiveConnectionScopes({ ...input, role: "node", verifiedIdentityWrite: true }),
  ).toEqual([]);
  upgradeReq.headers["x-openclaw-scopes"] = "";
  expect(resolveEffectiveConnectionScopes({ ...input, verifiedIdentityWrite: true })).toEqual([]);
});

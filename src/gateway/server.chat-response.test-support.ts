import { vi } from "vitest";
import type { RespondFn } from "./server-methods/shared-types.js";

type CapturedChatResult = { ok: boolean; payload?: unknown };
export type CapturedChatResponse = CapturedChatResult & { error?: unknown };

export function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

export function captureChatResult(results: CapturedChatResult[]): RespondFn {
  return (ok, payload) => {
    results.push({ ok, payload });
  };
}

export function captureChatResponse(responses: CapturedChatResponse[]): RespondFn {
  return (ok, payload, error) => {
    responses.push({ ok, payload, error });
  };
}

/* @vitest-environment jsdom */

import { useContext } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { mountTestTranscript } from "../test-helpers/chat-transcript-native.tsx";
import type { TranscriptPreparationRequest } from "./chat-transcript-layout.ts";
import * as transcriptPreparation from "./chat-transcript-preparation.ts";
import { GuardedTranscriptItem } from "./chat-transcript-render-guard.ts";
import { nativeRows } from "./chat-transcript-rows.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

function heldPreparation(key = 1) {
  let ready = false;
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  let completion = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const request = {
    key,
    ready: () => ready,
    load: vi.fn(() => completion),
  } satisfies TranscriptPreparationRequest;
  return {
    request,
    resolve() {
      ready = true;
      resolve();
    },
    reject,
    retry() {
      completion = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
    },
  };
}
const rows = (text: string, key = "row") => [
  { kind: "content" as const, key, content: <p>{text}</p> },
];

it("retains accepted rows and geometry until a whole replacement batch is available", async () => {
  const held = heldPreparation();
  const view = await mountTestTranscript("admission-retain", rows("Accepted"));
  const original = view.container.querySelector(".chat-virtual-row");
  const height = view.container.querySelector<HTMLElement>(".chat-thread-inner")!.style.height;
  view.renderRows([...rows("Replacement"), ...rows("Second", "row-2")], held.request);
  expect(view.container.textContent).toContain("Accepted");
  expect(view.container.textContent).not.toContain("Replacement");
  expect(view.container.querySelector(".chat-virtual-row")).toBe(original);
  expect(view.container.querySelector<HTMLElement>(".chat-thread-inner")!.style.height).toBe(
    height,
  );
  expect(held.request.load).toHaveBeenCalledOnce();
  held.resolve();
  await waitForSolid(() => expect(view.container.textContent).toContain("Replacement"));
  expect(view.container.querySelector(".chat-virtual-row")).toBe(original);
});

it("keeps first-load rows uncommitted and ignores a superseded preparation", async () => {
  const held = heldPreparation();
  const view = await mountTestTranscript("admission-first", rows("Stale"), undefined, held.request);
  expect(view.container.querySelector(".chat-virtual-row")).toBeNull();
  view.renderRows(rows("Current"));
  held.resolve();
  await waitForSolid(() => expect(view.container.textContent).toContain("Current"));
  expect(view.container.textContent).not.toContain("Stale");
});

it("shows import failure beside retained content and retries the current batch", async () => {
  const held = heldPreparation();
  const view = await mountTestTranscript("admission-retry", rows("Accepted"));
  const original = view.container.querySelector(".chat-virtual-row");
  view.renderRows(rows("Replacement"), held.request);
  held.reject(new Error("Renderer preparation failed"));
  await waitForSolid(() => expect(view.container.querySelector("[role=alert]")).not.toBeNull());
  expect(view.container.querySelector(".chat-virtual-row")).toBe(original);
  expect(view.container.textContent).toContain("Accepted");
  held.retry();
  view.container.querySelector<HTMLButtonElement>(".lazy-view-error__action")!.click();
  await waitForSolid(() => expect(held.request.load).toHaveBeenCalledTimes(2));
  held.resolve();
  await waitForSolid(() => expect(view.container.textContent).toContain("Replacement"));
  expect(view.container.querySelector("[role=alert]")).toBeNull();
  expect(view.container.querySelector(".chat-virtual-row")).toBe(original);
});

it("reuses admitted preparation, retains legacy inspection, and cannot publish after disposal", async () => {
  const held = heldPreparation();
  held.resolve();
  const view = await mountTestTranscript(
    "admission-resident",
    rows("Resident"),
    undefined,
    held.request,
  );
  expect(view.container.textContent).toContain("Resident");
  expect(held.request.load).not.toHaveBeenCalled();
  const inspectRows = vi.spyOn(transcriptPreparation, "prepareTranscriptRows");
  try {
    view.renderRows(rows("Legacy inspection"));
    expect(inspectRows).toHaveBeenCalled();
    inspectRows.mockClear();
    const admittedRows = rows("Already admitted");
    view.renderRows(admittedRows, null);
    view.renderRows(admittedRows, null);
    expect(view.container.textContent).toContain("Already admitted");
    expect(inspectRows).not.toHaveBeenCalled();
  } finally {
    inspectRows.mockRestore();
  }
  const late = heldPreparation(2);
  view.renderRows(rows("Disposed"), late.request);
  view.transcript.dispose();
  late.resolve();
  await Promise.resolve();
  expect(view.container.textContent).not.toContain("Disposed");
});

it("retires presentation while an import holds accepted rows", async () => {
  function PresentedControl() {
    const presented = useContext(ContentPresentation);
    return <button disabled={!presented()}>Accepted action</button>;
  }
  const held = heldPreparation();
  const renderTyping = vi.spyOn(nativeRows, "typing").mockImplementation(PresentedControl);
  const accepted = [
    {
      kind: "content" as const,
      key: "row",
      content: new GuardedTranscriptItem([], { kind: "typing", actors: [] }),
    },
  ];
  const view = await mountTestTranscript("admission-presentation", accepted);
  try {
    const button = view.container.querySelector<HTMLButtonElement>("button")!;
    expect(button.disabled).toBe(false);
    view.renderRows(rows("Replacement"), held.request, false);
    await waitForSolid(() => expect(button.disabled).toBe(true));
    expect(view.container.querySelector("button")).toBe(button);
    expect(view.container.textContent).not.toContain("Replacement");
    view.renderRows(rows("Replacement"), held.request, true);
    await waitForSolid(() => expect(button.disabled).toBe(false));
  } finally {
    renderTyping.mockRestore();
    held.resolve();
  }
});

it("retains model-change labels and provider icons through the lazy notice row", async () => {
  const item = {
    kind: "notice" as const,
    key: "model-change",
    text: "",
    timestamp: 1,
    label: "Model changed from openai/model-a to anthropic/model-b.",
    modelChange: { from: "openai/model-a", to: "anthropic/model-b" },
  };
  const catalog = [
    { id: "model-a", provider: "openai", name: "First model" },
    { id: "model-b", provider: "anthropic", name: "Second model" },
  ];
  const noticeRows = (modelCatalog = catalog) => [
    {
      kind: "content" as const,
      key: item.key,
      content: new GuardedTranscriptItem([item, modelCatalog], {
        kind: "notice",
        item,
        modelCatalog,
      }),
    },
  ];
  const view = await mountTestTranscript("admission-model-change", noticeRows());
  await waitForSolid(() =>
    expect(view.container.querySelector(".chat-notice--model-change")?.textContent).toContain(
      "First model",
    ),
  );
  const notice = view.container.querySelector(".chat-notice--model-change")!;
  expect([...notice.querySelectorAll("bdi")].map((name) => name.textContent)).toEqual([
    "First model",
    "Second model",
  ]);
  expect(notice.querySelectorAll("[data-provider-icon]")).toHaveLength(2);
  view.renderRows(noticeRows([{ ...catalog[0]!, name: "Renamed model" }, catalog[1]!]));
  await waitForSolid(() => expect(notice.textContent).toContain("Renamed model"));
  expect(view.container.querySelector(".chat-notice--model-change")).toBe(notice);
});

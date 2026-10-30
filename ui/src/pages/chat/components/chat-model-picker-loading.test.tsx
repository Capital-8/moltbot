import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installModelPickerLayout } from "../../../test-helpers/model-picker-layout.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { modelOption, modelPickerProps } from "./chat-model-picker.test-support.tsx";
import { ChatModelPicker } from "./chat-model-picker.tsx";

const panelLoad = vi.hoisted(() => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release: () => release(), started: vi.fn() };
});

// mock-isolation: Hold only the module boundary; resolve to the real result renderer.
vi.mock("./chat-model-picker-panel.tsx", async (importOriginal) => {
  panelLoad.started();
  await panelLoad.pending;
  return importOriginal<typeof import("./chat-model-picker-panel.tsx")>();
});

const cleanups: Array<() => void> = [];
beforeEach(installModelPickerLayout);
afterEach(() => {
  panelLoad.release();
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

function mountPicker() {
  const container = document.body.appendChild(document.createElement("div"));
  const props = modelPickerProps({
    modelOptions: [modelOption("example", "alpha"), modelOption("example", "beta")],
    selectedModelValue: "example/alpha",
    triggerModelLabel: "Alpha",
  });
  const view = mountSolid(() => <ChatModelPicker {...props} />, { container });
  cleanups.push(() => {
    view.unmount();
    container.remove();
  });
  flush();
  const trigger = container.querySelector<HTMLElement>("[data-chat-model-select]")!;
  const details = container.querySelector<HTMLDetailsElement>("details")!;
  const search = container.querySelector<HTMLInputElement>("[data-chat-model-search]")!;
  return { container, props, trigger, details, search };
}

it("focuses and retains the real input before result code arrives without stealing later focus", async () => {
  const closed = mountPicker();
  expect(panelLoad.started).not.toHaveBeenCalled();
  expect(closed.search.isConnected).toBe(true);
  closed.trigger.click();
  expect(closed.details.open).toBe(true);
  expect(document.activeElement).toBe(closed.search);
  flush();
  await vi.waitFor(() => expect(panelLoad.started).toHaveBeenCalledOnce());
  expect(closed.container.querySelectorAll("[data-chat-model-option]")).toHaveLength(0);
  closed.search.value = "beta";
  closed.search.dispatchEvent(new InputEvent("input", { bubbles: true }));
  flush();
  expect(closed.search.value).toBe("beta");
  closed.trigger.click();
  flush();
  expect(closed.details.open).toBe(false);

  const opened = mountPicker();
  opened.trigger.click();
  expect(document.activeElement).toBe(opened.search);
  flush();
  opened.search.value = "beta";
  opened.search.dispatchEvent(new InputEvent("input", { bubbles: true }));
  flush();
  // Enter before rows exist must not activate or replay a future selection.
  opened.search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(opened.props.onModelSelect).not.toHaveBeenCalled();
  expect(opened.search.value).toBe("beta");
  // Focus within the picker preserves its query; outside focus intentionally dismisses it.
  opened.trigger.focus();
  expect(opened.details.open).toBe(true);

  panelLoad.release();
  await vi.dynamicImportSettled();
  await waitForSolid(() => {
    expect(opened.container.querySelectorAll("[data-chat-model-search]")).toHaveLength(1);
    expect(opened.container.querySelector("[data-chat-model-search]")).toBe(opened.search);
    expect(opened.search.value).toBe("beta");
    const row = opened.container.querySelector<HTMLElement>(
      '[data-chat-model-option="example/beta"]',
    );
    expect(row).not.toBeNull();
    expect(opened.search.getAttribute("aria-activedescendant")).toBe(row!.id);
    const list = opened.container.querySelector<HTMLElement>("[data-chat-model-list]")!;
    expect(opened.search.getAttribute("aria-controls")?.split(" ")).toContain(list.id);
  });
  expect(document.activeElement).toBe(opened.trigger);
  expect(closed.details.open).toBe(false);
  expect(closed.search.value).toBe("");
  expect(opened.props.onModelSelect).not.toHaveBeenCalled();
  expect(panelLoad.started).toHaveBeenCalledOnce();
});

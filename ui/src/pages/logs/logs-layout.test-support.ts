import { vi } from "vitest";

export function installLogsViewport() {
  // jsdom has no layout; browser scenarios own native positioning proof.
  // The virtualizer sizes the scroll viewport from its client box and rows from offset boxes.
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return this.classList.contains("log-stream") ? 440 : 0;
  });
  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("log-row") ? 44 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(900);
}

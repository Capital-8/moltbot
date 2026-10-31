import { listen } from "../../lib/reactive/listener.ts";

/** One optional Board preparation job; input always gets a fresh quiet window. */
export function scheduleBoardIdlePreparation(prepare: () => boolean): () => void {
  const channel = new MessageChannel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  let active = true;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    if (idle !== undefined) {
      cancelIdleCallback(idle);
      idle = undefined;
    }
  };
  const schedule = (delay: number) => {
    cancel();
    if (active && document.visibilityState === "visible") {
      timer = setTimeout(() => {
        timer = undefined;
        if ("requestIdleCallback" in window) {
          idle = requestIdleCallback(() => {
            idle = undefined;
            channel.port2.postMessage(null);
          });
        } else {
          channel.port2.postMessage(null);
        }
      }, delay);
    }
  };
  const interrupt = () => schedule(500);
  const stops = [
    listen(document, "keydown", interrupt, { capture: true, passive: true }),
    listen(document, "beforeinput", interrupt, { capture: true, passive: true }),
    listen(document, "input", interrupt, { capture: true, passive: true }),
    listen(document, "pointerdown", interrupt, { capture: true, passive: true }),
    listen(document, "pointerup", interrupt, { capture: true, passive: true }),
    listen(document, "touchstart", interrupt, { capture: true, passive: true }),
    listen(document, "wheel", interrupt, { capture: true, passive: true }),
    listen(document, "touchmove", interrupt, { capture: true, passive: true }),
    listen(document, "scroll", interrupt, { capture: true, passive: true }),
    listen(document, "visibilitychange", interrupt),
    listen(channel.port1, "message", () => {
      // A queued message may outlive cancellation by input or navigation.
      if (
        !active ||
        timer !== undefined ||
        idle !== undefined ||
        document.visibilityState !== "visible"
      ) {
        return;
      }
      if (prepare()) {
        schedule(16);
      } else {
        dispose();
      }
    }),
  ];
  channel.port1.start();
  function dispose() {
    active = false;
    cancel();
    stops.forEach((stop) => stop());
    channel.port1.close();
    channel.port2.close();
  }
  schedule(500);
  return dispose;
}

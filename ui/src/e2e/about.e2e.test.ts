import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { expectAttribute, expectText, showHeading } from "./activity-assertions.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI About mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** Measures rail geometry in the page; baselines come from zero-size inline probes. */
function readRailGeometry(rail: Element) {
  const baseline = (element: Element) => {
    const probe = document.createElement("span");
    probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
    element.prepend(probe);
    const y = probe.getBoundingClientRect().bottom;
    probe.remove();
    return y;
  };
  const measure = (element: Element | null) => ({
    x: element?.getBoundingClientRect().left ?? Number.NaN,
    baseline: element ? baseline(element) : Number.NaN,
  });
  const card = rail.getBoundingClientRect();
  const entry = rail.querySelector(".about-build");
  const padding = entry ? Number.parseFloat(getComputedStyle(entry).paddingRight) : 0;
  return {
    overflow: rail.scrollWidth - rail.clientWidth,
    contentRight: card.right - padding,
    entries: Array.from(rail.querySelectorAll(".about-build")).map((item) => ({
      name: measure(item.querySelector(".about-build__name")),
      version: measure(item.querySelector(".about-build__version")),
      commit: measure(item.querySelector(".about-build__commit code")),
      meta: measure(item.querySelector(".about-build__meta")),
      glyphRight:
        item.querySelector(".about-build__commit svg")?.getBoundingClientRect().right ?? Number.NaN,
      glyphCenterOffset: (() => {
        const glyph = item.querySelector(".about-build__commit svg")?.getBoundingClientRect();
        const hash = item.querySelector(".about-build__commit code")?.getBoundingClientRect();
        return glyph && hash
          ? glyph.top + glyph.height / 2 - (hash.top + hash.height / 2)
          : Number.NaN;
      })(),
      hashToGlyph:
        (item.querySelector(".about-build__commit svg")?.getBoundingClientRect().left ??
          Number.NaN) -
        (item.querySelector(".about-build__commit code")?.getBoundingClientRect().right ??
          Number.NaN),
    })),
  };
}
const BUILT_AT = "2026-07-10T12:34:56.000Z";

suite.define(() => {
  it("shows browser and Gateway build identity in one rail for a member", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      operatorScopes: ["operator.sessions.read", "operator.sessions.write"],
      serverCommit: "abcdef0",
      serverBuiltAt: "2026-10-21T11:55:00.000Z",
    });

    try {
      const response = await page.goto(`${suite.server.baseUrl}settings/about`);
      expect(response?.status()).toBe(200);
      await showHeading(page, "Settings");

      const aboutLink = page.getByRole("link", { name: "About", exact: true });
      await expectAttribute(aboutLink, "aria-current").toBe("page");

      const rail = page.locator('dl[aria-label="Build information"]');
      const ui = rail.locator(".about-build", { hasText: "Control UI" });
      const gatewayEntry = rail.locator(".about-build", { hasText: "Gateway" });
      await expectText(ui.locator(".about-build__version")).toBe("Version 2026.7.10");
      const commit = ui.locator(".about-build__commit code");
      await expectText(commit).toBe(`Commit ${COMMIT.slice(0, 7)}`);
      await expectAttribute(commit, "title").toBe(COMMIT);
      await expectAttribute(ui.locator(".about-build__meta time"), "datetime").toBe(BUILT_AT);
      await expectText(gatewayEntry.locator(".about-build__version")).toBe("Version e2e");
      await expectText(gatewayEntry.locator(".about-build__commit code")).toBe("Commit abcdef0");
      await expectAttribute(gatewayEntry.locator(".about-build__meta time"), "datetime").toBe(
        "2026-10-21T11:55:00.000Z",
      );

      // Both entries share one grid: identical column edges, one baseline per
      // first line, and the copy glyph on the card's content edge.
      for (const viewport of [
        { width: 1280, height: 1000 },
        { width: 390, height: 1000 },
      ]) {
        await page.setViewportSize(viewport);
        // The settings shell animates between breakpoints; measure its settled layout.
        await expect
          .poll(() => rail.evaluate((element) => element.scrollWidth - element.clientWidth))
          .toBeLessThanOrEqual(0);
        const geometry = await rail.evaluate(readRailGeometry);
        const [first, second] = geometry.entries;
        expect(geometry.overflow).toBeLessThanOrEqual(0);
        expect(second?.name.x).toBeCloseTo(first!.name.x, 1);
        expect(second?.version.x).toBeCloseTo(first!.version.x, 1);
        expect(second?.meta.x).toBeCloseTo(first!.meta.x, 1);
        expect(first?.meta.x).toBeCloseTo(first!.version.x, 1);
        for (const entry of geometry.entries) {
          expect(entry.version.baseline).toBeCloseTo(entry.name.baseline, 0);
          expect(entry.commit.baseline).toBeCloseTo(entry.name.baseline, 0);
          expect(entry.glyphRight).toBeCloseTo(geometry.contentRight, 0);
          expect(entry.hashToGlyph).toBeCloseTo(12, 0);
          expect(Math.abs(entry.glyphCenterOffset)).toBeLessThanOrEqual(1);
        }
      }
      await page.setViewportSize({ width: 1280, height: 1000 });
      expect(await page.locator(".settings-section__desc").count()).toBe(0);

      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const surface = page.locator("openclaw-about-page");
        for (const viewport of [
          { name: "desktop", width: 1280, height: 1000 },
          { name: "mobile", width: 390, height: 1000 },
        ]) {
          const frame = await takeControlUiScreenshotFrame(page, surface, [rail], {
            animations: "disabled",
            viewport,
          });
          await writeFile(
            path.join(suite.artifactDir, `about-rail-${viewport.name}.png`),
            frame.png,
          );
        }
        await page.emulateMedia({ colorScheme: "dark" });
        const dark = await takeControlUiScreenshotFrame(page, surface, [rail], {
          animations: "disabled",
          viewport: { width: 1280, height: 1000 },
        });
        await writeFile(path.join(suite.artifactDir, "about-rail-desktop-dark.png"), dark.png);
        await page.emulateMedia({ colorScheme: "light" });
        await page.setViewportSize({ width: 1280, height: 1000 });
        console.log(`About proof: ${suite.artifactDir}`);
      }

      // The shared control swaps its accessible name to the result, so keep the element handle.
      const copy = gatewayEntry.locator(".about-build__commit .chat-copy-btn");
      await expectAttribute(copy, "aria-label").toBe("Copy full commit hash");
      await copy.click();
      await expect.poll(() => copy.getAttribute("data-copy-state")).toMatch(/^(copied|error)$/u);
      expect(await gateway.getRequests("system.info")).toHaveLength(0);
      expect(await gateway.getRequests("update.status")).toHaveLength(0);

      const clawd = page.getByRole("button", { name: "Wave hello to Clawd" });
      // CLAWD_WAVE_MS clears the class after 1400ms, so click and read it in one browser step.
      const clawdWaving = await clawd.evaluate(async (element) => {
        const button = element as HTMLButtonElement;
        const owner = element.closest("openclaw-about-page") as
          | (HTMLElement & {
              updateComplete: Promise<unknown>;
            })
          | null;
        if (!owner) {
          throw new Error("About page owner is unavailable");
        }
        button.click();
        await owner.updateComplete;
        return button.classList.contains("about-hero__clawd--wave");
      });
      expect(clawdWaving).toBe(true);

      await page.setViewportSize({ height: 812, width: 375 });
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        )
        .toBeLessThanOrEqual(1);
    } finally {
      await context.close();
    }
  });
});

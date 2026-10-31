import { expect, it, onTestFinished } from "vitest";
import { page, userEvent } from "vitest/browser";
import { i18n } from "../../../i18n/index.ts";
import { loadLazyLocaleTranslation } from "../../../i18n/lib/registry.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import "../../../test-helpers/load-styles.ts";
import { makeCapabilities, makeMenu } from "./chat-composer-menu.test-support.ts";
import { ChatComposerPlusMenu } from "./chat-composer-plus-menu.tsx";

it("wraps translated composer headings without adding keyboard stops", async () => {
  const locale = i18n.getLocale();
  const german = await loadLazyLocaleTranslation("de");
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  onTestFinished(async () => {
    cleanupSolid();
    if (german) {
      i18n.registerTranslation("de", german);
    }
    await i18n.setLocale(locale);
    await page.viewport(viewport.width, viewport.height);
  });
  i18n.registerTranslation("de", {
    chat: {
      composer: {
        menu: {
          attachSection: "Vorhandene Dateien und Bilder anhängen",
          capabilitiesSection: "Verfügbare Funktionen für diese Sitzung",
        },
      },
    },
  });
  await i18n.setLocale("de");
  await page.viewport(320, 800);
  const view = mountSolid(() => (
    <ChatComposerPlusMenu menu={makeMenu({ capabilityMenu: makeCapabilities() })} />
  ));
  view.container.style.cssText = "position:fixed;bottom:20px;left:12px";
  const trigger = view.container.querySelector<HTMLElement>('[aria-haspopup="menu"]')!;
  await page.elementLocator(trigger).click();
  await expect
    .poll(
      () =>
        view.container.querySelectorAll(
          ".agent-chat__capability-menu-body > .agent-chat__capability-menu-section",
        ).length,
    )
    .toBe(2);
  const panel = view.container.querySelector<HTMLElement>(".agent-chat__capability-menu-panel")!;
  for (const heading of view.container.querySelectorAll<HTMLElement>(
    ".agent-chat__capability-menu-body > .agent-chat__capability-menu-section",
  )) {
    const bounds = heading.getBoundingClientRect();
    expect(heading.scrollWidth).toBeLessThanOrEqual(heading.clientWidth);
    expect(bounds.left).toBeGreaterThanOrEqual(panel.getBoundingClientRect().left);
    expect(bounds.right).toBeLessThanOrEqual(panel.getBoundingClientRect().right);
    expect(heading.tabIndex).toBe(-1);
  }
  view.container.querySelector<HTMLElement>('[data-value="media"]')!.focus();
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe("file");
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe("open-skills");
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.activeElement).toBe(trigger);
});

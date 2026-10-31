import { createSignal } from "solid-js";
import { expect, it, onTestFinished } from "vitest";
import { page, userEvent } from "vitest/browser";
import { i18n } from "../../../i18n/index.ts";
import { loadLazyLocaleTranslation } from "../../../i18n/lib/registry.ts";
import type { SessionToolOverrides } from "../../../lib/sessions/patch.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import "../../../test-helpers/load-styles.ts";
import { makeCapabilities, makeMenu } from "./chat-composer-menu.test-support.ts";
import { ChatComposerPlusMenu } from "./chat-composer-plus-menu.tsx";

it("keeps plugin management visually secondary to capability navigation", async () => {
  onTestFinished(cleanupSolid);
  const view = mountSolid(() => (
    <ChatComposerPlusMenu
      menu={makeMenu({ view: "connectors", capabilityMenu: makeCapabilities() })}
    />
  ));
  const trigger = view.container.querySelector<HTMLElement>('[aria-haspopup="menu"]')!;
  await page.elementLocator(trigger).click();
  await expect
    .poll(() => view.container.querySelector('[data-value="manage-plugins"]'))
    .not.toBeNull();
  const label = (id: string) =>
    getComputedStyle(view.container.querySelector(`[data-value="${id}"] > .oc-menu-item__label`)!);
  const management = label("manage-plugins");
  const navigation = label("back");
  expect(Number.parseFloat(management.fontSize)).toBeLessThan(
    Number.parseFloat(navigation.fontSize),
  );
  expect(management.color).not.toBe(navigation.color);
});

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
  const [open, setOpen] = createSignal(false);
  const [overrides, setOverrides] = createSignal<SessionToolOverrides | null>(null);
  const menu = makeMenu({ capabilityMenu: makeCapabilities(), onOpenChange: setOpen });
  const view = mountSolid(() => (
    <ChatComposerPlusMenu menu={{ ...menu, open: open(), toolOverrides: overrides() }} />
  ));
  view.container.style.cssText = "position:fixed;bottom:20px;left:12px";
  const trigger = view.container.querySelector<HTMLElement>('[aria-haspopup="menu"]')!;
  trigger.focus();
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(
      () =>
        view.container.querySelectorAll(
          ".agent-chat__capability-menu-body > .agent-chat__capability-menu-section",
        ).length,
    )
    .toBe(2);
  await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe("camera");
  setOverrides({ webSearch: false });
  await expect
    .poll(() =>
      view.container
        .querySelector('[data-value="toggle-web-search"]')
        ?.getAttribute("aria-checked"),
    )
    .toBe("false");
  await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe("camera");
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

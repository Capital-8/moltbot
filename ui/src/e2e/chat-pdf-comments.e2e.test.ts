import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { pdfFixture } from "../test-helpers/pdf-fixture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "PDF comments" });

suite.define(() => {
  it.each(["scanned", "invalid"])(
    "offers an honest PDF outcome for a %s document",
    async (kind) => {
      await suite.withPage(
        { viewport: { width: 390, height: 844 }, colorScheme: "dark" },
        async ({ page }) => {
          const url = "/__openclaw__/assistant-media?mediaTicket=pdf-fallback-fixture";
          await page.route("**/__openclaw__/assistant-media?**", (route) =>
            route.fulfill({
              contentType: "application/pdf",
              body:
                kind === "invalid" ? Buffer.from("not a PDF") : Buffer.from(pdfFixture(["", ""])),
            }),
          );
          await installMockGateway(page, {
            historyMessages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "attachment",
                    attachment: {
                      kind: "document",
                      label: "brief.pdf",
                      mimeType: "application/pdf",
                      url,
                    },
                  },
                ],
              },
            ],
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.locator(".chat-assistant-attachment-card__expand").click();
          await page
            .getByText(
              kind === "invalid"
                ? "This PDF could not be displayed. Open the original to view or unlock it."
                : "This page has no selectable text. Scanned pages need OCR before you can comment on text.",
              { exact: true },
            )
            .waitFor();
          const original = page.getByRole("link", { name: "Open original PDF", exact: true });
          expect(await original.getAttribute("href")).toMatch(/^blob:/);
          expect(await page.getByRole("button", { name: "Add to chat", exact: true }).count()).toBe(
            0,
          );
        },
      );
    },
  );
  it.each([0, 90, 180, 270])(
    "sends an aligned PDF selection rotated %i degrees",
    async (rotation) => {
      await suite.withPage(
        { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" },
        async ({ page }) => {
          const url = "/__openclaw__/assistant-media?mediaTicket=pdf-comment-fixture";
          await page.route("**/__openclaw__/assistant-media?**", (route) =>
            route.fulfill({
              contentType: "application/pdf",
              body: Buffer.from(pdfFixture(undefined, [0, rotation])),
            }),
          );
          const gateway = await installMockGateway(page, {
            historyMessages: [
              {
                role: "assistant",
                content: [
                  { type: "text", text: "Review the release checklist." },
                  {
                    type: "attachment",
                    attachment: {
                      kind: "document",
                      label: "release-checklist.pdf",
                      mimeType: "application/pdf",
                      url,
                    },
                  },
                ],
              },
            ],
          });
          await page.route(`${suite.server.baseUrl}chat`, async (route) => {
            const response = await route.fetch();
            const body = await response.text();
            await route.fulfill({
              response,
              body,
              headers: {
                ...response.headers(),
                "content-security-policy": buildControlUiCspHeader({
                  inlineScriptHashes: computeInlineScriptHashes(body),
                }),
              },
            });
          });
          const worker = page.waitForEvent("worker", {
            predicate: (value) => value.url().endsWith("/pdf.worker.min.js"),
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          const card = page
            .locator(".chat-assistant-attachment-card--compact")
            .filter({ hasText: "release-checklist.pdf" });
          await card.locator(".chat-assistant-attachment-card__expand").click();
          const surface = page.locator(".sidebar-pdf-preview");
          await worker;
          await page.getByRole("button", { name: "Next page", exact: true }).click();
          const text = surface
            .locator(".textLayer span")
            .filter({ hasText: "Confirm the rollback owner." });
          await text.waitFor();
          // Measure actual canvas ink, not the overlay: a DOM-range selection alone
          // passes even when the selectable text is detached from the rendered PDF.
          const ink = await surface.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
            const context = canvas.getContext("2d")!;
            const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
            let left = canvas.width;
            let top = canvas.height;
            let right = 0;
            let bottom = 0;
            for (let y = 0; y < canvas.height; y++) {
              for (let x = 0; x < canvas.width; x++) {
                const offset = (y * canvas.width + x) * 4;
                if (data[offset]! < 128 && data[offset + 3]! > 128) {
                  left = Math.min(left, x);
                  top = Math.min(top, y);
                  right = Math.max(right, x + 1);
                  bottom = Math.max(bottom, y + 1);
                }
              }
            }
            const bounds = canvas.getBoundingClientRect();
            return {
              x: bounds.x + (left / canvas.width) * bounds.width,
              y: bounds.y + (top / canvas.height) * bounds.height,
              width: ((right - left) / canvas.width) * bounds.width,
              height: ((bottom - top) / canvas.height) * bounds.height,
            };
          });
          if (rotation === 90 && process.env.OPENCLAW_PDF_ROTATION_CAPTURE) {
            await text.evaluate((element) => {
              const range = document.createRange();
              range.selectNodeContents(element);
              window.getSelection()?.removeAllRanges();
              window.getSelection()?.addRange(range);
            });
            const frame = await takeControlUiScreenshotFrame(page, surface, [surface, text], {
              animations: "disabled",
            });
            await writeFile(
              suite.artifactDir +
                "/pdf-rotation-" +
                process.env.OPENCLAW_PDF_ROTATION_CAPTURE +
                ".png",
              frame.png,
            );
            await page.evaluate(() => window.getSelection()?.removeAllRanges());
          }
          const overlay = await text.boundingBox();
          expect(overlay).not.toBeNull();
          expect(ink.width).toBeGreaterThan(0);
          expect(ink.height).toBeGreaterThan(0);
          expect(ink.x).toBeGreaterThanOrEqual(overlay!.x - 2);
          expect(ink.y).toBeGreaterThanOrEqual(overlay!.y - 2);
          expect(ink.x + ink.width).toBeLessThanOrEqual(overlay!.x + overlay!.width + 2);
          expect(ink.y + ink.height).toBeLessThanOrEqual(overlay!.y + overlay!.height + 2);
          const horizontal = rotation % 180 === 0;
          const start = horizontal
            ? { x: ink.x - 2, y: ink.y + ink.height / 2 }
            : { x: ink.x + ink.width / 2, y: ink.y - 2 };
          const end = horizontal
            ? { x: ink.x + ink.width + 2, y: start.y }
            : { x: start.x, y: ink.y + ink.height + 2 };
          const reverse = rotation === 180 || rotation === 270;
          const from = reverse ? end : start;
          const to = reverse ? start : end;
          await page.mouse.move(from.x, from.y);
          await page.mouse.down();
          await page.mouse.move(to.x, to.y, { steps: 20 });
          await page.mouse.up();
          expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
            "Confirm the rollback owner.",
          );
          await page.getByRole("button", { name: "Add to chat", exact: true }).click();
          const editor = page.getByRole("dialog", { name: "Comment", exact: true });
          await editor.getByRole("textbox").fill("Name the on-call owner here.");
          await editor.getByRole("textbox").press("Enter");
          await page.locator(".chat-selection-annotations__chip").hover();
          await page.getByText("release-checklist.pdf · Page 2", { exact: true }).waitFor();
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          const request = await gateway.waitForRequest("chat.send");
          // SAFETY: the mock captures the production composer's chat.send request.
          const params = request.params as { attachments: Array<{ content: string }> };
          const payload = Buffer.from(params.attachments[0]!.content, "base64").toString("utf8");
          expect(payload).toContain("Confirm the rollback owner.");
          expect(payload).toContain("Name the on-call owner here.");
          expect(payload).toContain('Source PDF: "release-checklist.pdf"');
          expect(payload).toContain("Source page: 2");
        },
      );
    },
  );
});

import { writeFile } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import { expect, it } from "vitest";
import { createDarkDesktopControlUiContextOptions } from "../../e2e/control-ui-browser-options.test-support.ts";
import { seedSidebarSettings } from "../../e2e/sidebar-contract.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  waitForControlUiRoute,
} from "../../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
it.skipIf(!canRunPlaywrightChromium(executablePath))(
  "loads the creator on the first sidebar action and keeps duplicate clicks behind one admission",
  async () => {
    const server = await startControlUiE2eServer();
    const release = Promise.withResolvers<void>();
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ executablePath });
      const page = await browser.newPage(createDarkDesktopControlUiContextOptions());
      await seedSidebarSettings(page, server.baseUrl, { sidebarAgentsMode: "roster" });
      const config = { gateway: { controlUi: { experimental: { templates: true } } } };
      const scope = { input: "Repository", job: "Summarize", output: "Brief", authority: "Read" };
      const gateway = await installMockGateway(page, {
        assistantName: "Harbor",
        featureMethods: [
          "chat.send",
          "templates.drafts.create",
          "templates.drafts.read",
          "templates.drafts.review",
        ],
        methodResponses: {
          "config.get": {
            config,
            sourceConfig: config,
            hash: "creator-first-use",
            valid: true,
            issues: [],
          },
          "templates.drafts.create": {
            draftId: "ec8f46b0-4ca3-4991-8a73-dfdcc8764087",
            prompt: "Create a shareable Template",
          },
          "templates.drafts.read": { revision: "a".repeat(64), content: JSON.stringify({ scope }) },
          "templates.drafts.review": {
            revision: "a".repeat(64),
            reviewToken: "b".repeat(64),
            publisher: "maker",
            name: "@maker/first-use",
            displayName: "First use",
            version: "0.1.0",
            description: "First-use Template",
            items: [],
            files: [],
            scope,
          },
        },
      });
      const imports: string[] = [];
      page.on("request", (request) => {
        if (/\/template-creator-runtime-[^/]+\.js$/u.test(new URL(request.url()).pathname)) {
          imports.push(request.url());
        }
      });
      await page.goto(`${server.baseUrl}chat`);
      await waitForControlUiRoute(page, { routeId: "chat" });
      const row = page.locator('.sidebar-agent-roster__row[data-agent-id="main"]');
      const menu = page.getByRole("button", { name: "Options for Harbor" });
      await menu.waitFor({ state: "visible" });
      expect(imports).toEqual([]);
      let held = 0;
      await page.route("**/assets/template-creator-runtime-*.js", async (route) => {
        held += 1;
        await release.promise;
        await route.continue();
      });
      await gateway.deferNext("chat.send");
      await row.hover();
      await menu.click();
      await page.getByRole("menuitem", { name: "Create Template", exact: true }).click();
      await expect.poll(() => held).toBe(1);
      await row.hover();
      await menu.click();
      await page.getByRole("menuitem", { name: "Create Template", exact: true }).click();
      expect(await gateway.getRequests("templates.drafts.create")).toHaveLength(0);
      release.resolve();
      await gateway.waitForRequest("chat.send");
      const creates = await gateway.getRequests("templates.drafts.create");
      expect(creates).toHaveLength(1);
      expect(creates[0]?.params).toEqual({ agentId: "main" });
      expect(imports).toHaveLength(1);
      const dialog = page.getByRole("dialog", { name: "Review your Template" });
      expect(await dialog.count()).toBe(0);
      await gateway.resolveDeferred("chat.send", { status: "started" });
      await dialog.waitFor({ state: "visible" });
      expect(await dialog.getByLabel("Name").inputValue()).toBe("First use");
      expect(await gateway.getRequests("templates.drafts.create")).toHaveLength(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
    } finally {
      release.resolve();
      await browser?.close();
      await server.close();
    }
  },
);

it.skipIf(!canRunPlaywrightChromium(executablePath))(
  "publishes the reviewed selection after closing a pending publish and retrying its failure",
  async () => {
    const server = await startControlUiE2eServer();
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ executablePath });
      const page = await browser.newPage(createDarkDesktopControlUiContextOptions());
      const draftId = "ec8f46b0-4ca3-4991-8a73-dfdcc8764087";
      const optionalFile = "workspace/checklist.md";
      const scope = { input: "Repository", job: "Summarize", output: "Brief", authority: "Read" };
      const reviewed = {
        revision: "a".repeat(64),
        reviewToken: "b".repeat(64),
        publisher: "maker",
        name: "@maker/release-brief",
        displayName: "Release Brief",
        version: "0.1.0",
        description: "Summarizes releases",
        items: [
          {
            id: `file:${optionalFile}`,
            kind: "file",
            label: optionalFile,
            detail: "Check each date and citation.",
            included: true,
          },
        ],
        files: [
          { path: "CLAW.md", content: "Portable release instructions" },
          { path: optionalFile, content: "Check each date and citation." },
        ],
        scope,
      };
      const config = { gateway: { controlUi: { experimental: { templates: true } } } };
      const gateway = await installMockGateway(page, {
        featureMethods: ["create", "read", "review", "publish"].map(
          (op) => `templates.drafts.${op}`,
        ),
        methodResponses: {
          "config.get": {
            config,
            sourceConfig: config,
            hash: "templates-review-config",
            valid: true,
            issues: [],
          },
          "templates.drafts.read": {
            content: JSON.stringify({ name: "release-brief", scope }),
            revision: reviewed.revision,
          },
          "templates.drafts.review": reviewed,
          "templates.drafts.publish": {
            name: reviewed.name,
            version: reviewed.version,
            url: "https://clawhub.ai/maker/templates/release-brief",
            publicationStatus: "pending",
          },
        },
      });
      const setReview = (token: string) =>
        gateway.setMethodResponse("templates.drafts.review", {
          ...reviewed,
          reviewToken: token.repeat(64),
          items: reviewed.items.map((item) => ({ ...item, included: false })),
          files: reviewed.files.filter((file) => file.path !== optionalFile),
        });
      const waitForRequests = (method: string, count: number) =>
        expect.poll(async () => (await gateway.getRequests(method)).length).toBe(count);
      await page.goto(`${server.baseUrl}templates?draft=${draftId}&agent=main`);
      const dialog = page.getByRole("dialog", { name: "Review your Template" });
      await dialog.waitFor();
      const proofDir = createControlUiE2eArtifactDir("templates-rename-creator-after");
      const frame = await takeControlUiScreenshotFrame(
        page,
        dialog,
        [dialog.getByRole("button", { name: "Publish to ClawHub" })],
        { animations: "disabled" },
      );
      await writeFile(`${proofDir}/after-creator.png`, frame.png);
      expect(await dialog.getByText("View", { exact: true }).count()).toBe(1);
      expect(await dialog.getByLabel("Description").inputValue()).toBe("Summarizes releases");
      await setReview("d");
      await dialog.getByRole("checkbox", { name: optionalFile }).uncheck();
      await waitForRequests("templates.drafts.review", 2);
      await gateway.deferNext("templates.drafts.publish");
      await dialog.getByRole("button", { name: "Publish to ClawHub" }).click();
      await gateway.waitForRequest("templates.drafts.publish");
      await expect
        .poll(() => dialog.locator("button.btn.primary").getAttribute("aria-busy"))
        .toBe("true");
      await dialog.locator(".btn__spinner").waitFor({ state: "visible" });
      await dialog.getByRole("button", { name: "Ask for changes" }).click();
      await dialog.waitFor({ state: "detached" });
      await gateway.rejectDeferred("templates.drafts.publish", {
        code: "UNAVAILABLE",
        message: "The package upload was interrupted.",
      });
      const publicationError = page.getByRole("alert");
      await publicationError.waitFor();
      expect(await publicationError.textContent()).toContain("The package upload was interrupted.");
      expect(await page.getByRole("button", { name: "Review Template package" }).count()).toBe(0);
      await setReview("e");
      await publicationError.getByRole("button", { name: "Retry review" }).click();
      await waitForRequests("templates.drafts.review", 3);
      await dialog.getByRole("button", { name: "Publish to ClawHub" }).click();
      await waitForRequests("templates.drafts.publish", 2);
      const published = await gateway.getRequests("templates.drafts.publish");
      expect(published[1]?.params).toMatchObject({
        reviewToken: "e".repeat(64),
        choices: {
          excluded: [`file:${optionalFile}`],
        },
      });
      await page
        .getByText("Submitted to ClawHub. Publication pending security review.")
        .waitFor({ state: "visible" });
      await page.getByRole("button", { name: "View on ClawHub" }).waitFor({ state: "visible" });
      expect(await page.locator(".template-creator__notice").count()).toBe(0);
      expect(await dialog.count()).toBe(0);
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);

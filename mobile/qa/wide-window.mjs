// Headless, disposable browser evidence. Uses the existing design fixture server
// and demo transport; never starts a native app or connects to a user's Host.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, expect } from "@playwright/test";

const mobile = fileURLToPath(new URL("..", import.meta.url));
const output = process.env.DURE_WIDE_QA_OUTPUT ?? await mkdtemp(join(tmpdir(), "dure-wide-qa-"));
for (const directory of ["home", "dure", "discovery", "artifacts"]) await mkdir(join(output, directory), { recursive: true });
const env = { ...process.env, HOME: join(output, "home"), DURE_HOME: join(output, "dure"),
  HMUX_DISCOVERY_ROOT: join(output, "discovery"), VITE_DURE_DEMO: "1", NO_COLOR: "1" };
const server = spawn(process.execPath, [join(mobile, "node_modules/vite/bin/vite.js"),
  "--config", "qa/vite.config.ts", "--host", "127.0.0.1", "--port", "0"],
{ cwd: mobile, env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
server.stderr.on("data", data => { log += data; });
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Fixture server did not start: ${log}`)), 30_000);
  server.once("error", error => { clearTimeout(timer); reject(error); });
  server.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture server exited ${code}: ${log}`)); });
  server.stdout.on("data", data => {
    log += data;
    const url = /Local:\s+(http:\/\/127\.0\.0\.1:\d+\/)/.exec(log)?.[1];
    if (url) { clearTimeout(timer); resolve(url); }
  });
});

try {
  const url = await ready;
  for (const [name, browserType] of Object.entries({ chromium, webkit })) {
    const browser = await browserType.launch({ headless: true, env });
    let page;
    try {
      page = await browser.newPage({ viewport: { width: 1024, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      const shot = label => page.screenshot({ path: join(output, "artifacts", `${name}-${label}.png`) });
      const evidence = () => page.evaluate(() => window.wideQA);
      const sidebar = page.locator(".workspace__list");
      const terminal = page.locator(".session__terminal");
      const box = page.locator(".tray__box");
      const back = page.locator(".scm .session__header .icon-tap").first();
      await page.goto(`${url}wide.html`);
      await expect(page.getByRole("tab", { name: "Main", exact: true })).toBeVisible();
      await expect(page.getByRole("tab", { name: "Personal", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Select a session" })).toBeVisible();
      await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(320);
      await shot("empty-wide");
      console.log(`${name}: empty/list layout verified`);

      await page.locator('[data-session-id="s-term"]').click();
      await expect(terminal.locator(".terminal-viewport-row").first()).toBeVisible();
      await expect(page.locator(".session__back")).toBeHidden();
      await expect(page.locator(".session__icon--sessions")).toBeHidden();
      await expect(page.locator('[data-session-id="s-term"]')).toHaveAttribute("aria-current", "true");
      const node = await terminal.elementHandle();
      const field = await box.elementHandle();
      await terminal.click({ position: { x: 100, y: 80 } });
      await expect(box).toBeFocused();
      // Hardware typing uses the real textarea -> protocol -> synthetic Host.
      for (let line = 0; line < 35; line++) {
        await page.keyboard.insertText(`echo scrollback-${line}`);
        await page.keyboard.press("Enter");
      }
      await page.keyboard.insertText("echo preserved-draft");
      const draft = await box.inputValue();
      const sizes = [[839, 900], [840, 900], [390, 844], [1180, 820], [820, 1180], [1366, 1024], [1024, 700]];
      for (const [width, height] of sizes) {
        await page.setViewportSize({ width, height });
        await expect.poll(async () => (await evidence()).resizes.at(-1)?.columns).toBeGreaterThan(8);
        assert.equal(await terminal.evaluate((current, saved) => current === saved, node), true);
        assert.equal(await box.evaluate((current, saved) => current === saved, field), true);
        await expect(box).toBeFocused();
        assert.equal(await box.inputValue(), draft);
        assert.equal((await evidence()).attachments.length, 1);
        assert.equal((await evidence()).detaches.length, 0);
        const rect = await page.locator(".session").boundingBox();
        assert.equal(rect.x, width >= 840 ? 320 : 0);
        assert.equal(Math.round(rect.width), width >= 840 ? width - 320 : width);
        if (width < 840) await expect(sidebar).toBeHidden();
        else await expect(sidebar).toBeVisible();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      const resizeColumns = (await evidence()).resizes.map(item => item.columns);
      assert.ok(new Set(resizeColumns).size > 3, "Terminal grid must refit each column width");
      console.log(`${name}: resize preserves attachment, field, focus and draft`);

      // A refreshed sidebar must not rebuild the textarea while an IME owns it.
      await box.dispatchEvent("compositionstart");
      await page.evaluate(() => { window.wideQA.catalogRevision++; });
      await expect(sidebar.locator('[data-session-id="s-term"]')).toContainText("refreshed 1", { timeout: 10_000 });
      assert.equal(await box.evaluate((current, saved) => current === saved, field), true);
      await expect(box).toBeFocused();
      await box.dispatchEvent("compositionend");
      await page.keyboard.press("Enter");
      await expect(terminal).toContainText("preserved-draft");
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("Control+c");
      assert.ok((await evidence()).inputs.some(input => input.key === "ArrowUp"));

      // Mobile history uses finger gestures. Exercise that production path
      // with synthetic touches; desktop wheel input only scrolls the DOM.
      await terminal.evaluate(host => {
        for (const [type, clientY] of [["touchstart", 150], ["touchmove", 500], ["touchend", 500]]) {
          const event = new Event(type, { bubbles: true, cancelable: true });
          Object.defineProperty(event, "touches", { value: [{ identifier: 1, clientX: 450, clientY }] });
          host.dispatchEvent(event);
        }
      });
      await expect.poll(async () => (await evidence()).frames.at(-1)?.followTail).toBe(false);
      for (const width of [390, 1180, 840, 1024]) {
        await page.setViewportSize({ width, height: 700 });
        await expect.poll(async () => (await evidence()).frames.at(-1)?.followTail).toBe(false);
        assert.equal(await terminal.evaluate((current, saved) => current === saved, node), true);
      }
      await shot("terminal-wide");
      console.log(`${name}: census, hardware keys and scrollback verified`);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator(".session__back")).toBeVisible();
      await expect(page.locator(".session__icon--sessions")).toBeVisible();
      await shot("terminal-narrow");
      await page.setViewportSize({ width: 1024, height: 900 });

      // Git is the detail route; the current attachment is kept underneath it.
      await page.locator(".session__icon--connection").click();
      await expect(page.locator(".scm__file-open").first()).toBeVisible();
      assert.equal((await page.locator(".scm").boundingBox()).x, 320);
      await page.locator(".scm__file-open").first().click();
      await expect(page.locator(".diff__body, .diff__lines, .diff__line").first()).toBeVisible();
      await shot("diff-wide");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(sidebar).toBeHidden();
      await page.setViewportSize({ width: 1024, height: 900 });
      await back.click();
      await back.click();
      assert.equal(await terminal.evaluate((current, saved) => current === saved, node), true);
      assert.equal((await evidence()).attachments.length, 1);
      assert.equal((await evidence()).detaches.length, 0);

      await page.locator(".session__icon--connection").click();
      await page.locator('.scm__file input[type="checkbox"]').first().check();
      await page.locator(".prform__footer button").click();
      await page.locator(".prform__textarea").fill("QA commit draft");
      await expect(sidebar).toHaveJSProperty("inert", true);
      const sheet = await page.locator(".sheet").boundingBox();
      assert.equal(sheet.x, 320);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator(".prform__textarea")).toHaveValue("QA commit draft");
      await page.setViewportSize({ width: 1024, height: 900 });
      await shot("commit-sheet-wide");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(sidebar).toHaveJSProperty("inert", false);
      // An explicit new selection replaces the detail and attaches exactly once.
      await sidebar.locator('[data-session-id="s-pay-retry"]').click();
      await expect(terminal).toBeVisible();
      await expect.poll(async () => (await evidence()).attachments.length).toBe(2);
      await expect(page.locator(".scm")).toHaveCount(0);
      await page.getByRole("tab", { name: "Personal", exact: true }).click();
      await expect(terminal).toBeVisible();
      assert.equal((await evidence()).attachments.length, 2);
      // Returning to phone navigation is still Back -> current session list.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator(".session__back").click();
      await expect(terminal).toHaveCount(0);
      await expect(page.getByRole("tab", { name: "Personal", exact: true })).toHaveAttribute("aria-selected", "true");
      await shot("home-narrow");
      await page.setViewportSize({ width: 1024, height: 900 });
      await expect(page.getByRole("heading", { name: "Select a session" })).toBeVisible();
      assert.deepEqual(errors, []);
      await writeFile(join(output, "artifacts", `${name}-evidence.json`), JSON.stringify(await evidence(), null, 2));
      console.log(`${name}: PASS — resize, attachment/draft/scrollback, hardware keys, census, Git/diff/sheet, navigation`);
    } catch (error) {
      if (page) {
        await page.screenshot({ path: join(output, "artifacts", `${name}-failure.png`) });
        await writeFile(join(output, "artifacts", `${name}-failure.json`), JSON.stringify(await page.evaluate(() => window.wideQA), null, 2));
      }
      throw error;
    } finally { await browser.close(); }
  }
} finally {
  server.kill("SIGTERM");
  await writeFile(join(output, "artifacts", "vite.log"), log);
  console.log(`Evidence: ${output}`);
}

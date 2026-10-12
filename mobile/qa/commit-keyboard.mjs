// Full app + demo transport in disposable headless browsers. The viewport events
// are synthetic: this verifies CSS/input integration, not a native iOS keyboard.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, expect } from "@playwright/test";

const mobile = fileURLToPath(new URL("..", import.meta.url));
const output = process.env.DURE_COMMIT_QA_OUTPUT ?? await mkdtemp(join(tmpdir(), "dure-commit-qa-"));
for (const directory of ["home", "dure", "discovery", "artifacts"]) {
  await mkdir(join(output, directory), { recursive: true });
}
const env = { ...process.env, HOME: join(output, "home"), DURE_HOME: join(output, "dure"),
  HMUX_DISCOVERY_ROOT: join(output, "discovery"), VITE_DURE_DEMO: "1", NO_COLOR: "1" };
// A fresh fixture cache preserves existing worktree/dependency caches.
const config = join(output, "vite.config.mjs");
await writeFile(config, `import base from ${JSON.stringify(new URL("vite.config.ts", import.meta.url).href)};
export default { ...base, cacheDir: ${JSON.stringify(join(output, "vite-cache"))} };\n`);
const server = spawn(process.execPath, [join(mobile, "node_modules/vite/bin/vite.js"),
  "--config", config, "--configLoader", "runner", "--host", "127.0.0.1", "--port", "0"],
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
const failures = [];
try {
  const url = await ready;
  for (const [name, browserType] of Object.entries({ chromium, webkit })) {
    const browser = await browserType.launch({ headless: true, env });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 },
        locale: "en-US", reducedMotion: "reduce" });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(() => {
        const viewport = new EventTarget();
        let geometry;
        Object.defineProperties(viewport, {
          height: { get: () => geometry?.height ?? innerHeight },
          width: { get: () => innerWidth },
          offsetTop: { get: () => geometry?.top ?? 0 },
          scale: { get: () => 1 },
        });
        Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
        window.commitKeyboardQA = (next, event = "resize") => {
          geometry = next;
          viewport.dispatchEvent(new Event(event));
          // Make the occluded area explicit in screenshots without a native IME.
          let keyboard = document.querySelector("#fixture-keyboard");
          if (!keyboard) {
            keyboard = document.createElement("div");
            keyboard.id = "fixture-keyboard";
            keyboard.textContent = "Simulated keyboard area · browser fixture";
            document.body.append(keyboard);
          }
          Object.assign(keyboard.style, { position: "fixed", zIndex: "9999", left: "0", right: "0",
            bottom: "0", height: `${next ? Math.max(0, innerHeight - next.top - next.height) : 0}px`,
            background: "#464646", color: "white", display: next ? "grid" : "none",
            placeItems: "center", font: "12px system-ui", pointerEvents: "none" });
        };
      });
      await page.goto(`${url}wide.html`);
      await page.locator('[data-session-id="s-term"]').click();
      await expect(page.locator(".session__terminal")).toBeVisible();
      await page.locator(".session__icon--connection").click();
      await page.locator('.scm__file input[type="checkbox"]').first().check();
      await page.locator(".prform__footer button").click();
      const field = page.locator(".sheet textarea");
      const original = await field.elementHandle();
      const records = [];
      const measure = async (label, { short = false, wide = false } = {}) => {
        await page.evaluate(async () => {
          await Promise.all(document.querySelector(".sheet").getAnimations({ subtree: true })
            .map(animation => animation.finished));
        });
        const record = await page.evaluate(() => {
          const rect = selector => {
            const box = document.querySelector(selector).getBoundingClientRect();
            return { top: box.top, bottom: box.bottom, left: box.left, width: box.width, height: box.height };
          };
          return { viewport: { top: visualViewport.offsetTop, bottom: visualViewport.offsetTop + visualViewport.height },
            sheet: rect(".sheet"), panel: rect(".sheet__panel"), field: rect(".sheet textarea"),
            submit: rect(".sheet .pair-button--solid") };
        });
        records.push({ label, ...record });
        const check = (ok, reason) => { if (!ok) failures.push(`${name}/${label}: ${reason}`); };
        const inside = box => box.top >= record.viewport.top - 1 && box.bottom <= record.viewport.bottom + 1;
        check(inside(record.sheet), "sheet escapes the visible viewport");
        check(inside(record.panel), "panel escapes the visible viewport");
        check(Math.abs(record.sheet.bottom - record.viewport.bottom) <= 1, "sheet does not sit above the keyboard");
        check(record.sheet.left === (wide ? 320 : 0), "sheet escaped its navigation column");
        if (!short) {
          check(inside(record.field), "message field is obscured");
          check(inside(record.submit), "Commit button is obscured");
        }
        await page.screenshot({ path: join(output, "artifacts", `${name}-${label}.png`) });
      };
      const viewport = async (height, top, event = "resize") => {
        await page.evaluate(({ height, top, event }) => window.commitKeyboardQA({ height, top }, event), { height, top, event });
        await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--app-viewport-height"))).toBe(`${height}px`);
      };
      await measure("keyboard-down");
      await field.focus();
      await viewport(508, 0);
      await field.dispatchEvent("compositionstart", { data: "" });
      await field.evaluate(node => {
        node.value = "한";
        node.dispatchEvent(new InputEvent("input", { bubbles: true, data: "한", isComposing: true }));
      });
      await measure("typing");
      await viewport(480, 32, "scroll");
      await measure("typing-panned");
      await field.dispatchEvent("compositionend", { data: "한" });
      await field.fill("한글 commit draft");
      await viewport(508, 0, "scroll");
      await measure("typing-settled");
      await page.setViewportSize({ width: 1024, height: 820 });
      await viewport(480, 36);
      await measure("wide-keyboard", { wide: true });
      await page.setViewportSize({ width: 844, height: 390 });
      await viewport(190, 16);
      await measure("short-landscape", { short: true, wide: true });
      await page.locator(".sheet__panel").evaluate(panel => { panel.scrollTop = panel.scrollHeight; });
      const reachable = await page.locator(".sheet .pair-button--solid").boundingBox();
      if (!(reachable.y >= 16 && reachable.y + reachable.height <= 206)) {
        failures.push(`${name}/short-landscape: Commit is unreachable by scrolling the panel`);
      }
      await page.evaluate(() => window.commitKeyboardQA(undefined));
      await measure("keyboard-dismissed", { wide: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(field).toHaveValue("한글 commit draft");
      await expect(field).toBeFocused();
      assert.equal(await field.evaluate((node, saved) => node === saved, original), true);
      await page.locator(".sheet .pair-button--ghost").click();
      await expect(page.locator(".sheet")).toHaveCount(0);
      await expect(page.locator(".workspace__list")).toHaveJSProperty("inert", false);
      assert.deepEqual(errors, []);
      await writeFile(join(output, "artifacts", `${name}-geometry.json`), JSON.stringify(records, null, 2));
      console.log(`${name}: ${failures.filter(value => value.startsWith(name)).length} geometry failures; field/composition draft and navigation retained`);
    } finally { await browser.close(); }
  }
  assert.deepEqual(failures, []);
} finally {
  server.kill("SIGTERM");
  await writeFile(join(output, "artifacts", "vite.log"), log);
  await writeFile(join(output, "artifacts", "failures.json"), JSON.stringify(failures, null, 2));
  console.log(`Evidence: ${output}`);
}

// Reuses the source browser QA pattern from schedule-workspace-browser.mjs.
// Run with the repository storage-admission runner. No installed app or native IPC.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const output = resolve("output/playwright/project-move");
await mkdir(output, { recursive: true });
const isolated = await mkdtemp(join(tmpdir(), "dure-project-move-browser-"));
const executablePath = chromium.executablePath();
process.env.HOME = join(isolated, "home");
process.env.DURE_HOME = join(isolated, "dure");
process.env.HMUX_DISCOVERY_ROOT = join(isolated, "discovery");
await Promise.all([process.env.HOME, process.env.DURE_HOME, process.env.HMUX_DISCOVERY_ROOT].map(path => mkdir(path, { recursive: true })));
const server = await createServer({
  root: process.cwd(), cacheDir: join(output, "cache"), logLevel: "warn",
  optimizeDeps: { entries: ["scripts/qa/project-move.fixture.html"] },
  plugins: [{ name: "project-move-presentation-fixture", enforce: "pre", resolveId(id) {
    if ((id === "@/lib/agents/agentProjectMove" || id === resolve("src/lib/agents/agentProjectMove.ts") || id === resolve("src/lib/agents/agentProjectMove"))) return resolve("scripts/qa/project-move.fixture-actions.ts");
  } }],
  server: { host: "127.0.0.1", port: 0, hmr: false },
});
let browser;
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({ executablePath });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, colorScheme: "dark" });
  page.on("pageerror", error => errors.push(String(error)));
  const url = `http://127.0.0.1:${server.httpServer.address().port}/scripts/qa/project-move.fixture.html`;
  await page.goto(`${url}?before`);
  await page.getByRole("heading", { name: "Conversation · Original project" }).waitFor();
  await page.screenshot({ path: join(output, "before.png") });
  await page.goto(url);
  await page.getByRole("button", { name: "Move conversation to project", exact: true }).click();
  const destination = page.getByRole("combobox");
  await destination.click();
  await page.getByRole("option", { name: "Destination project", exact: true }).click();
  await page.screenshot({ path: join(output, "selection.png") });
  await page.getByRole("button", { name: "Preview move", exact: true }).click();
  await page.getByText("/projects/destination", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.projectMoveEvidence.applies), 0);
  await page.screenshot({ path: join(output, "preview.png") });
  await page.getByRole("button", { name: "Restart and move", exact: true }).click();
  await page.getByRole("button", { name: "Check status", exact: true }).waitFor();
  await page.screenshot({ path: join(output, "uncertain.png") });
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  const repair = page.getByRole("button", { name: "Resume in original folder", exact: true });
  await repair.waitFor();
  await page.screenshot({ path: join(output, "repair.png") });
  await page.setViewportSize({ width: 390, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(output, "narrow.png") });
  await repair.click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const evidence = await page.evaluate(() => window.projectMoveEvidence);
  assert.deepEqual(evidence, { previews: 1, applies: 1, inspections: 1, repairs: 1 });
  assert.deepEqual(errors, []);
  await writeFile(join(output, "evidence.json"), JSON.stringify({ native: false, backend: "presentation fixture", browser: "headless Chromium", before: "fixture toolbar before move action existed", ...evidence, narrowOverflow: false, errors }, null, 2));
  console.log(`PASS project move presentation interactions and screenshots: ${output}`);
} finally {
  await browser?.close();
  await server.close();
  await rm(isolated, { recursive: true, force: true });
}

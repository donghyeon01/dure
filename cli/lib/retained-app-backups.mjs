// Retained copies of earlier Dure app bundles.
//
// A `.app` copy kept for rollback under App Backups is a registered
// application to LaunchServices. Launched by bundle id, it would claim the app
// channel and republish shared integration files that point into its own
// bundle. New copies are therefore created as `<name>.app-backup`, which
// LaunchServices treats as a plain folder, and the installed app's startup
// renames idle legacy `.app` copies the same way. A copy that still runs a
// process keeps its name until that process exits, so live sessions are never
// cut off from their executables. Nothing is deleted; an explicit rollback
// copies a backup back to /Applications/Dure.app.

import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import {
  INERT_APP_BACKUP_SUFFIX,
  INSTALLED_APP_BUNDLE,
  classifyAppBundle,
  enclosingAppBundle,
  inspectRetainedAppBackups,
  isDureBundleIdentifier,
  readBundleInfo,
  readProcessTable,
  retainedAppBackupsRoot,
} from "./app-bundle-identity.mjs";

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const MAX_RENAMES_PER_STARTUP = 32;

/** Refuse before a retained backup copy publishes any shared integration file. */
export function assertNotRetainedAppBackup({ sourcePath, home }) {
  const bundlePath = enclosingAppBundle(sourcePath);
  if (bundlePath && classifyAppBundle(bundlePath, { home }) === "retained_backup") {
    throw new Error(
      `refusing to publish shared Dure integration files from a retained app backup (${bundlePath}); open the installed Dure app instead`,
    );
  }
}

export function unregisterFromLaunchServices(bundlePath, { run = spawnSync } = {}) {
  const result = run(LSREGISTER, ["-u", bundlePath], { stdio: "ignore", timeout: 5_000 });
  return !result?.error && result?.status === 0;
}

function pathExists(pathname) {
  try {
    lstatSync(pathname);
    return true;
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

function sourceRevision(appBundle, readFile) {
  try {
    const metadata = JSON.parse(readFile(join(
      appBundle, "Contents", "Resources", "resources", "dure-cli", "current", "install.json",
    ), "utf8"));
    const revision = metadata?.bundle?.app?.sourceRevision;
    return /^[0-9a-f]{40}$/.test(revision ?? "") ? revision.slice(0, 12) : null;
  } catch {
    return null;
  }
}

function dittoCopy(source, target) {
  const result = spawnSync("/usr/bin/ditto", [source, target], { stdio: "pipe", timeout: 300_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`ditto could not copy ${source}: ${String(result.stderr ?? result.error ?? "").trim()}`);
  }
}

/**
 * Copy an installed Dure app into App Backups in its inert form, named
 * `Dure-<version>-<revision>-<yyyymmdd>.app-backup`. The copy is staged under
 * a non-bundle name and renamed into place, and an existing copy is never
 * replaced.
 */
export function retainAppBackup({
  home,
  appBundle = INSTALLED_APP_BUNDLE,
  now = new Date(),
  copy = dittoCopy,
  rename = renameSync,
  exists = pathExists,
  mkdir = mkdirSync,
  readFile = readFileSync,
  remove = rmSync,
}) {
  const info = readBundleInfo(appBundle, { readFile });
  if (!isDureBundleIdentifier(info?.identifier) || !info.version) {
    throw new Error(`${appBundle} is not a Dure app bundle`);
  }
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  const stem = ["Dure", info.version, sourceRevision(appBundle, readFile), date].filter(Boolean).join("-");
  const root = retainedAppBackupsRoot(home);
  mkdir(root, { recursive: true, mode: 0o700 });
  let target = null;
  for (let attempt = 1; attempt <= 99 && target === null; attempt += 1) {
    const candidate = join(root, `${stem}${attempt === 1 ? "" : `-${attempt}`}${INERT_APP_BACKUP_SUFFIX}`);
    if (!exists(candidate) && !exists(`${candidate}.partial`)) target = candidate;
  }
  if (target === null) throw new Error(`no free backup name for ${stem} in ${root}`);
  const staging = `${target}.partial`;
  try {
    copy(appBundle, staging);
    rename(staging, target);
  } catch (error) {
    // Only this call's own staging copy is removed; the target never existed.
    remove(staging, { recursive: true, force: true });
    throw error;
  }
  return { schemaVersion: 1, source: appBundle, path: target, version: info.version };
}

function inertBackupName(name) {
  return `${name.slice(0, -".app".length)}${INERT_APP_BACKUP_SUFFIX}`;
}

/**
 * Rename every idle retained `.app` backup to its inert name. Idempotent:
 * inert entries are reported, in-use or unprovable entries are skipped, an
 * existing inert target is never replaced, and failures never stop startup.
 */
export function makeRetainedAppBackupsInert({
  home,
  processes,
  unregister = unregisterFromLaunchServices,
  rename = renameSync,
  exists = pathExists,
  inspect = inspectRetainedAppBackups,
}) {
  const inspection = inspect({ home, processes });
  const entries = [];
  let renamed = 0;
  for (const entry of inspection.entries) {
    if (entry.state !== "launchable") {
      entries.push({ name: entry.name, state: entry.state, processIds: entry.processIds });
      continue;
    }
    if (renamed >= MAX_RENAMES_PER_STARTUP) {
      entries.push({ name: entry.name, state: "deferred", processIds: [] });
      continue;
    }
    const inertPath = `${entry.path.slice(0, -entry.name.length)}${inertBackupName(entry.name)}`;
    if (exists(inertPath)) {
      entries.push({ name: entry.name, state: "conflict", processIds: [] });
      continue;
    }
    // Unregister while the bundle is still at its registered path, then make
    // the name itself non-launchable so a later scan cannot register it again.
    const unregistered = unregister(entry.path);
    try {
      rename(entry.path, inertPath);
      renamed += 1;
      entries.push({
        name: entry.name,
        state: "made_inert",
        inertName: basename(inertPath),
        launchServices: unregistered ? "unregistered" : "unregister_failed",
        processIds: [],
      });
    } catch (error) {
      entries.push({
        name: entry.name,
        state: "failed",
        code: typeof error?.code === "string" ? error.code : "rename_failed",
        processIds: [],
      });
    }
  }
  return { schemaVersion: 1, root: inspection.root, state: inspection.state, entries };
}

/** Startup entry point: never throws, so it cannot block CLI promotion. */
export function reconcileRetainedAppBackups({
  home,
  readProcesses = readProcessTable,
  exists = pathExists,
  ...options
}) {
  try {
    const root = retainedAppBackupsRoot(home);
    // Most installs never retain a copy; skip the process census for them.
    if (!exists(root)) return { schemaVersion: 1, root, state: "absent", entries: [] };
    return makeRetainedAppBackupsInert({ home, processes: readProcesses(), exists, ...options });
  } catch (error) {
    return { schemaVersion: 1, state: "failed", message: String(error?.message ?? error).slice(0, 256) };
  }
}

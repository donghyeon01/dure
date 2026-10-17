// Which copy of the Dure app bundle a process actually runs from.
//
// macOS LaunchServices registers every `.app` directory that carries Dure's
// bundle identifier, wherever it lives. A copy retained for rollback can be
// launched by bundle id (a notification click, `open -b`, Spotlight), and the
// Hmux hosts and provider drivers it starts outlive it. macOS also attributes
// a session's privacy requests to the app copy that started the session's
// process tree, so access granted to the installed app does not cover a
// session that another copy started. Everything here only reads: paths,
// Info.plist files, shared hook scripts, the process table and the macOS
// responsible-process lookup.

import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

/** Retained copies of earlier app bundles, relative to the user's home. */
export const RETAINED_APP_BACKUP_SEGMENTS = Object.freeze([
  "Library", "Application Support", "Dure", "App Backups",
]);
/** A retained bundle renamed with this suffix is a plain folder to LaunchServices. */
export const INERT_APP_BACKUP_SUFFIX = ".app-backup";
export const INSTALLED_APP_BUNDLE = "/Applications/Dure.app";

const DURE_BUNDLE_IDENTIFIER = "io.hebbian.ade";
const MAX_INFO_PLIST_BYTES = 256 * 1024;
const MAX_ANCESTRY = 64;
const MAX_LISTED_DESCENDANTS = 8;
const BUNDLE_DIRECTORY = String.raw`\/.*?\.app(?:-backup)?`;
const BUNDLE_PATH = new RegExp(`^(${BUNDLE_DIRECTORY})\\/Contents(?:\\/|$)`, "i");
// The app, its bundled Hmux binaries, or a tool from the CLI package that
// ships inside the bundle. Commands keep their arguments after a space.
const BUNDLE_EXECUTABLE = new RegExp(
  `^(${BUNDLE_DIRECTORY})\\/Contents\\/(?:MacOS\\/(dure|hmux-runtime|hmux)|` +
    "Resources\\/resources\\/dure-cli\\/(?:versions\\/[^/]+|current)\\/bin\\/([A-Za-z0-9._-]+))(?=\\s|$)",
  "i",
);

/** Shared hook scripts whose commands embed the publishing app's bundle path. */
export const BUNDLE_INTEGRATION_FILES = Object.freeze([
  "managed-claude-hook-v2.sh",
  "managed-codex-native.sh",
]);
const MAX_INTEGRATION_FILE_BYTES = 64 * 1024;
const QUOTED_BUNDLE_PATH = new RegExp(`'(${BUNDLE_DIRECTORY})\\/Contents\\/`, "i");

function canonical(pathname) {
  try {
    return realpathSync(pathname);
  } catch {
    return pathname;
  }
}

function contains(parent, child) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function samePath(left, right) {
  return left === right || canonical(left) === canonical(right);
}

export function retainedAppBackupsRoot(home) {
  return join(home, ...RETAINED_APP_BACKUP_SEGMENTS);
}

export function isDureBundleIdentifier(identifier) {
  return identifier === DURE_BUNDLE_IDENTIFIER ||
    (typeof identifier === "string" && identifier.startsWith(`${DURE_BUNDLE_IDENTIFIER}.`));
}

/** The `.app` (or inert backup) directory that contains `pathname`. */
export function enclosingAppBundle(pathname) {
  return BUNDLE_PATH.exec(String(pathname ?? ""))?.[1] ?? null;
}

function processRole(executableName, firstArgument) {
  if (executableName === "dure") return "app";
  if (executableName === "hmux-runtime") return "hmux_runtime";
  if (executableName === "hmux") return "hmux";
  if (executableName === "dure-control-plane") {
    if (firstArgument === "managed-claude-hook") return "provider_hook";
    if (/-driver$/.test(firstArgument ?? "")) return "provider_driver";
    return "control_plane";
  }
  return "bundled_tool";
}

/** A process command that runs an executable from inside a Dure app bundle. */
export function bundleProcess(command) {
  const text = String(command ?? "");
  const match = BUNDLE_EXECUTABLE.exec(text);
  if (!match) return null;
  const executableName = match[2] ?? match[3];
  const firstArgument = text.slice(match[0].length).trim().split(/\s+/)[0] || null;
  return {
    bundlePath: match[1],
    executableName,
    role: processRole(executableName.toLowerCase(), firstArgument),
  };
}

/**
 * Where a bundle sits relative to the copy that should own shared state:
 * `retained_backup` inside App Backups, `current` for the running (or, when
 * none runs, the installed) app's bundle, `applications` for another copy in
 * an Applications folder, and `other` for anything else, including a bundle
 * that has since been moved or deleted.
 */
export function classifyAppBundle(bundlePath, { home, currentBundlePath = null } = {}) {
  if (!bundlePath) return "unbundled";
  const root = retainedAppBackupsRoot(home);
  if (contains(root, bundlePath) || contains(canonical(root), canonical(bundlePath))) {
    return "retained_backup";
  }
  if (currentBundlePath && samePath(bundlePath, currentBundlePath)) return "current";
  const parent = dirname(bundlePath);
  if (parent === "/Applications" || parent === join(home, "Applications")) return "applications";
  return "other";
}

function plistString(source, key) {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]{1,256})</string>`).exec(source);
  return match ? match[1].trim() : null;
}

/** Identifier and version from a bundle's XML Info.plist, or null. */
export function readBundleInfo(bundlePath, { readFile = readFileSync } = {}) {
  try {
    const raw = readFile(join(bundlePath, "Contents", "Info.plist"));
    if (raw.length > MAX_INFO_PLIST_BYTES) return null;
    const source = raw.toString("utf8");
    return {
      identifier: plistString(source, "CFBundleIdentifier"),
      version: plistString(source, "CFBundleShortVersionString"),
    };
  } catch {
    return null;
  }
}

export function parseProcessTable(raw) {
  const processes = [];
  for (const line of String(raw ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line);
    if (match) {
      processes.push({ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] });
    }
  }
  return processes;
}

/** The macOS process table, or null when it cannot be read. */
export function readProcessTable({ run = spawnSync, platform = process.platform } = {}) {
  if (platform !== "darwin") return null;
  const result = run("/bin/ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result?.error || result?.status !== 0 || typeof result.stdout !== "string") return null;
  return parseProcessTable(result.stdout);
}

// macOS attributes a process's privacy access to its "responsible" process:
// the app that started its process tree, even after Hmux reparents the host
// to launchd. libSystem exports the lookup without a public header; JXA can
// bind it. Any failure yields null and callers fall back to process ancestry.
const RESPONSIBLE_PROCESS_SCRIPT = [
  'ObjC.bindFunction("responsibility_get_pid_responsible_for_pid", ["int", ["int"]]);',
  "function run(argv) { return String($.responsibility_get_pid_responsible_for_pid(Number(argv[0]))); }",
].join("\n");

export function readResponsibleProcessId(pid, { run = spawnSync, platform = process.platform } = {}) {
  if (platform !== "darwin" || !Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const result = run(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", RESPONSIBLE_PROCESS_SCRIPT, String(pid)],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (result?.error || result?.status !== 0 || typeof result.stdout !== "string") return null;
    const responsible = Number(result.stdout.trim());
    return Number.isSafeInteger(responsible) && responsible > 1 ? responsible : null;
  } catch {
    return null;
  }
}

/** The nearest ancestor of `pid` (or `pid` itself) that runs from a Dure bundle. */
export function sessionRuntimeProcess(processes, pid) {
  const byPid = new Map((processes ?? []).map((entry) => [entry.pid, entry]));
  let current = byPid.get(pid);
  for (let depth = 0; current && depth < MAX_ANCESTRY; depth += 1) {
    const bundle = bundleProcess(current.command);
    if (bundle) return { processId: current.pid, ...bundle };
    if (current.parentPid <= 1 || current.parentPid === current.pid) break;
    current = byPid.get(current.parentPid);
  }
  return null;
}

function commandName(command) {
  const executable = String(command).split(/\s+/)[0] || "";
  return basename(executable).replace(/[^A-Za-z0-9._-]/g, "?").slice(0, 64);
}

function descendantsOf(processes, rootPid) {
  const children = new Map();
  for (const entry of processes) {
    if (entry.pid === entry.parentPid) continue;
    const siblings = children.get(entry.parentPid) ?? [];
    siblings.push(entry);
    children.set(entry.parentPid, siblings);
  }
  const found = [];
  const queue = [...(children.get(rootPid) ?? [])];
  const seen = new Set([rootPid]);
  while (queue.length > 0 && found.length < 4096) {
    const entry = queue.shift();
    if (seen.has(entry.pid)) continue;
    seen.add(entry.pid);
    found.push(entry);
    queue.push(...(children.get(entry.pid) ?? []));
  }
  return found;
}

function describeBundle(bundlePath, context, readFile) {
  const info = readBundleInfo(bundlePath, { readFile });
  return {
    bundlePath,
    version: info?.version ?? null,
    location: classifyAppBundle(bundlePath, context),
  };
}

/**
 * Dure bundle processes grouped by bundle, excluding the current bundle. A
 * process whose direct parent runs from the same bundle is already part of
 * that parent's tree and is not listed again.
 */
export function bundleProcessGroups(processes, context, { readFile = readFileSync } = {}) {
  const byPid = new Map((processes ?? []).map((entry) => [entry.pid, entry]));
  const groups = new Map();
  for (const entry of processes ?? []) {
    const bundle = bundleProcess(entry.command);
    if (!bundle) continue;
    const parent = byPid.get(entry.parentPid);
    const parentBundle = parent && parent.pid !== entry.pid ? bundleProcess(parent.command) : null;
    if (parentBundle && parentBundle.bundlePath === bundle.bundlePath) continue;
    let group = groups.get(bundle.bundlePath);
    if (!group) {
      group = { ...describeBundle(bundle.bundlePath, context, readFile), processes: [] };
      groups.set(bundle.bundlePath, group);
    }
    if (group.location === "current") continue;
    const descendants = descendantsOf(processes, entry.pid);
    group.processes.push({
      processId: entry.pid,
      role: bundle.role,
      descendantCount: descendants.length,
      descendantCommands: [...new Set(descendants
        .filter((descendant) => !bundleProcess(descendant.command))
        .map((descendant) => commandName(descendant.command)))]
        .slice(0, MAX_LISTED_DESCENDANTS),
    });
  }
  return [...groups.values()].filter((group) => group.location !== "current");
}

/**
 * Retained bundles in App Backups and whether LaunchServices can still treat
 * them as applications. Without a process table (`processes` is not an
 * array) a `.app` copy cannot be proven idle and is reported as `unknown`.
 */
export function inspectRetainedAppBackups({
  home,
  processes,
  readdir = readdirSync,
  lstat = lstatSync,
  readFile = readFileSync,
}) {
  const root = retainedAppBackupsRoot(home);
  let names;
  try {
    names = readdir(root);
  } catch (error) {
    return { root, state: error?.code === "ENOENT" ? "absent" : "unreadable", entries: [] };
  }
  const running = (processes ?? [])
    .map((entry) => ({ pid: entry.pid, bundle: bundleProcess(entry.command) }))
    .filter((entry) => entry.bundle);
  const entries = [];
  for (const name of [...names].sort()) {
    const lower = name.toLowerCase();
    const inert = lower.endsWith(INERT_APP_BACKUP_SUFFIX);
    if (!inert && !lower.endsWith(".app")) continue;
    const path = join(root, name);
    let metadata;
    try {
      metadata = lstat(path);
    } catch {
      continue;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
    const info = readBundleInfo(path, { readFile });
    if (!isDureBundleIdentifier(info?.identifier)) continue;
    const processIds = running
      .filter((entry) => samePath(entry.bundle.bundlePath, path))
      .map((entry) => entry.pid);
    let state;
    if (processIds.length > 0) state = "in_use";
    else if (inert) state = "inert";
    else state = Array.isArray(processes) ? "launchable" : "unknown";
    entries.push({ name, path, version: info.version, state, processIds });
  }
  return { root, state: "present", entries };
}

/**
 * Which bundle each shared hook script in `controlDirectory` executes from.
 * The app rewrites them only when it starts, so after another copy ran they
 * can keep pointing into that copy, or at a path that no longer exists.
 */
export function inspectIntegrationFiles({
  controlDirectory,
  home,
  currentBundlePath = null,
  readFile = readFileSync,
  lstat = lstatSync,
}) {
  const files = [];
  for (const name of BUNDLE_INTEGRATION_FILES) {
    const path = join(controlDirectory, name);
    let source;
    try {
      const raw = readFile(path);
      if (raw.length > MAX_INTEGRATION_FILE_BYTES) continue;
      source = raw.toString("utf8");
    } catch {
      continue;
    }
    const bundlePath = QUOTED_BUNDLE_PATH.exec(source)?.[1] ?? null;
    if (!bundlePath) {
      files.push({ name, path, bundlePath: null, location: "unbundled", exists: true });
      continue;
    }
    let exists = true;
    try {
      lstat(bundlePath);
    } catch {
      exists = false;
    }
    files.push({
      name,
      path,
      bundlePath,
      location: classifyAppBundle(bundlePath, { home, currentBundlePath }),
      exists,
    });
  }
  return files;
}

/**
 * The Dure copy macOS holds responsible for `sessionProcessId`: the live
 * responsible process when it runs from a Dure bundle, otherwise the nearest
 * Dure bundle process among its ancestors (a provider driver, for example).
 */
function sessionRuntime(processes, sessionProcessId, responsibleProcessId) {
  const responsible = responsibleProcessId === null
    ? null
    : processes.find((entry) => entry.pid === responsibleProcessId);
  const responsibleBundle = responsible ? bundleProcess(responsible.command) : null;
  if (responsibleBundle) {
    return { processId: responsible.pid, ...responsibleBundle, attribution: "responsible_process" };
  }
  const ancestor = sessionRuntimeProcess(processes, sessionProcessId);
  return ancestor ? { ...ancestor, attribution: "process_ancestry" } : null;
}

/**
 * The app, this process's session runtime and every other Dure bundle that
 * still runs processes, as `dure diagnostics` and permission failures report
 * them. `appProcessId` is the running app's process from its descriptor and
 * `responsibleProcessId` the result of `readResponsibleProcessId`.
 */
export function inspectRuntimeIdentity({
  home,
  appProcessId = null,
  sessionProcessId = process.pid,
  responsibleProcessId = null,
  controlDirectory = null,
  processes,
  platform = process.platform,
  readFile = readFileSync,
  readdir = readdirSync,
  lstat = lstatSync,
  installedAppBundle = INSTALLED_APP_BUNDLE,
}) {
  if (platform !== "darwin") return { schemaVersion: 1, state: "unsupported_platform" };
  const appEntry = appProcessId === null
    ? null
    : (processes ?? []).find((entry) => entry.pid === appProcessId);
  const appBundle = appEntry ? bundleProcess(appEntry.command) : null;
  const installed = readBundleInfo(installedAppBundle, { readFile }) ? installedAppBundle : null;
  const context = { home, currentBundlePath: appBundle?.bundlePath ?? installed };
  const app = appBundle
    ? { processId: appEntry.pid, ...describeBundle(appBundle.bundlePath, { home }, readFile) }
    : null;
  const sessionProcess = processes
    ? sessionRuntime(processes, sessionProcessId, responsibleProcessId)
    : null;
  const session = sessionProcess
    ? {
        processId: sessionProcess.processId,
        role: sessionProcess.role,
        attribution: sessionProcess.attribution,
        ...describeBundle(sessionProcess.bundlePath, context, readFile),
      }
    : null;
  return {
    schemaVersion: 1,
    state: processes ? "available" : "process_table_unavailable",
    currentBundlePath: context.currentBundlePath,
    app,
    session,
    otherBundles: processes ? bundleProcessGroups(processes, context, { readFile }) : [],
    integrationFiles: controlDirectory
      ? inspectIntegrationFiles({ controlDirectory, home, currentBundlePath: context.currentBundlePath, readFile, lstat })
      : [],
    retainedBackups: inspectRetainedAppBackups({ home, processes, readdir, lstat, readFile }),
  };
}

function bundleLabel(bundle) {
  const version = bundle.version ? `Dure ${bundle.version}` : "unknown version";
  return `${bundle.bundlePath} (${version})`;
}

/**
 * One sentence for a macOS permission failure: which Dure copy macOS checks
 * for this session, and what to do when it is not the current app.
 */
export function permissionAttributionHint(identity) {
  const session = identity?.session;
  if (!session) return null;
  const subject = `macOS checks this permission against the Dure copy that started this session: ${bundleLabel(session)}.`;
  if (session.location === "current") return subject;
  const which = session.location === "retained_backup"
    ? "That copy is a retained backup, not the installed app"
    : "That copy is not the running Dure app";
  return `${subject} ${which}, so access granted to ${identity.currentBundlePath ?? "the installed Dure app"} does not apply here. ` +
    "This session keeps running; start a new session from the installed app for desktop control instead of restarting the app.";
}

/**
 * Diagnostic issues and recovery steps for `inspectRuntimeIdentity`. The steps
 * name every affected bundle and process tree before any restart advice, and
 * never suggest stopping a session: a restart of the app moves no session.
 */
export function runtimeIdentityFindings(identity) {
  const issues = [];
  const steps = [];
  if (!identity || identity.state === "unsupported_platform") return { issues, steps };
  const current = identity.currentBundlePath ?? "the installed Dure app";
  if (identity.app?.location === "retained_backup") {
    issues.push("app_running_from_retained_backup");
    steps.push(
      `The running Dure app is a retained backup copy: ${bundleLabel(identity.app)}. ` +
        "It publishes this channel's descriptor and hook scripts from its own bundle, and macOS permission prompts name it. " +
        "Managed sessions keep running when the app quits: save unsent drafts, quit this copy, then open the installed Dure app so it republishes those files.",
    );
  }
  if (identity.session && identity.session.location !== "current") {
    issues.push("session_runtime_not_current");
    steps.push(
      `This terminal's session was started by ${bundleLabel(identity.session)} [${identity.session.location}], not by ${current}. ` +
        "macOS checks Accessibility and Screen Recording for this session against that copy, so granting them to the installed app or restarting the app does not change it. " +
        "The session itself keeps working; when it needs desktop control, finish or save its work and start a new session from the installed app.",
    );
  }
  const otherBundles = identity.otherBundles ?? [];
  if (otherBundles.length > 0) issues.push("runtime_processes_not_current");
  for (const group of otherBundles) {
    const trees = group.processes.map((entry) =>
      `pid ${entry.processId} ${entry.role}${entry.descendantCommands.length > 0 ? ` (${entry.descendantCommands.join(", ")})` : ""}`);
    steps.push(
      `${group.processes.length} process tree(s) still run from ${bundleLabel(group)} [${group.location}]: ${trees.join("; ")}. ` +
        "They belong to sessions that copy started and keep its permissions and executable paths until those sessions end; restarting the app does not move them. " +
        "Identify their sessions with dure ls and dure inspect before ending any, and do not stop processes you do not own.",
    );
  }
  const staleFiles = (identity.integrationFiles ?? []).filter((file) => file.bundlePath && (
    file.location === "retained_backup" || !file.exists ||
    (identity.currentBundlePath && file.location !== "current")));
  if (staleFiles.length > 0) {
    issues.push("integration_files_not_current");
    const bundles = [...new Set(staleFiles.map((file) =>
      `${file.bundlePath} [${file.location}${file.exists ? "" : ", missing"}]`))];
    steps.push(
      `Shared hook scripts ${staleFiles.map((file) => file.name).join(", ")} run executables from ${bundles.join(", ")}, not from ${current}. ` +
        "Managed Claude hooks and Codex launches use them, so hook events and new Codex sessions can fail or run that copy. " +
        "The app rewrites them only when it starts: save unsent drafts, then quit and reopen the installed Dure app. Managed sessions keep running across the restart.",
    );
  }
  const launchable = (identity.retainedBackups?.entries ?? []).filter((entry) => entry.state !== "inert");
  if (launchable.length > 0) {
    issues.push("retained_app_backup_launchable");
    steps.push(
      `${launchable.length} retained backup bundle(s) in ${identity.retainedBackups.root} are still applications to macOS: ` +
        `${launchable.map((entry) => `${entry.name} (${entry.state})`).join(", ")}. ` +
        `Opening the installed app renames idle ones to <name>${INERT_APP_BACKUP_SUFFIX} so macOS can no longer launch them; ` +
        "one with running processes keeps its name until they exit, and nothing is deleted. " +
        "To roll back deliberately, quit Dure and replace /Applications/Dure.app with a copy of the backup named Dure.app.",
    );
  }
  return { issues, steps };
}

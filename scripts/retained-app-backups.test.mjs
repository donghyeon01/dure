import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bundleProcess,
  classifyAppBundle,
  enclosingAppBundle,
  inspectRetainedAppBackups,
  inspectRuntimeIdentity,
  parseProcessTable,
  permissionAttributionHint,
  readProcessTable,
  readResponsibleProcessId,
  retainedAppBackupsRoot,
  runtimeIdentityFindings,
  sessionRuntimeProcess,
} from "../cli/lib/app-bundle-identity.mjs";
import {
  assertNotRetainedAppBackup,
  makeRetainedAppBackupsInert,
  reconcileRetainedAppBackups,
  retainAppBackup,
} from "../cli/lib/retained-app-backups.mjs";
import {
  createDiagnosticReport,
  formatDiagnosticReport,
} from "../cli/lib/runtime-diagnostics.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-app-backups-"));
  roots.push(root);
  return root;
}

function writeBundle(bundlePath, { identifier = "io.hebbian.ade", version = "0.2.39" } = {}) {
  fs.mkdirSync(path.join(bundlePath, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(bundlePath, "Contents", "Info.plist"), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<plist version=\"1.0\"><dict>",
    "  <key>CFBundleIdentifier</key>",
    `  <string>${identifier}</string>`,
    "  <key>CFBundleShortVersionString</key>",
    `  <string>${version}</string>`,
    "</dict></plist>",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(bundlePath, "Contents", "MacOS", "dure"), "fixture executable\n");
  return bundlePath;
}

const CONTROL_PLANE = "Contents/Resources/resources/dure-cli/versions/0.2.39+f8060e1c7de38b39/bin/dure-control-plane";

describe("Dure app bundle identity", () => {
  it("finds the bundle and role of an executable path that contains spaces", () => {
    const backup = "/Users/fixture/Library/Application Support/Dure/App Backups/Dure-0.2.39-10b6a2f25ee5-20260927.app";
    expect(bundleProcess(`${backup}/${CONTROL_PLANE} codex-native-driver --runtime /x -- codex`)).toEqual({
      bundlePath: backup,
      executableName: "dure-control-plane",
      role: "provider_driver",
    });
    expect(bundleProcess(`${backup}/Contents/MacOS/dure`)).toMatchObject({ bundlePath: backup, role: "app" });
    expect(bundleProcess("/Applications/Dure.app/Contents/MacOS/hmux-runtime host --session s1"))
      .toMatchObject({ bundlePath: "/Applications/Dure.app", role: "hmux_runtime" });
    expect(bundleProcess("/Applications/Dure.app/Contents/MacOS/dure-helper")).toBeNull();
    expect(bundleProcess("/Applications/Other.app/Contents/MacOS/Other")).toBeNull();
    expect(bundleProcess("/usr/bin/codex")).toBeNull();
    expect(enclosingAppBundle(`${backup}/Contents/Resources/resources/dure-cli/versions/0.2.39+x/bin/lib/dure-cli-bootstrap.mjs`))
      .toBe(backup);
    expect(enclosingAppBundle("/tmp/target/debug/dure")).toBeNull();
  });

  it("classifies retained, current, installed and other bundle locations", () => {
    const home = "/Users/fixture";
    const root = retainedAppBackupsRoot(home);
    expect(root).toBe("/Users/fixture/Library/Application Support/Dure/App Backups");
    const context = { home, currentBundlePath: "/Applications/Dure.app" };
    expect(classifyAppBundle(`${root}/Dure-0.2.39.app`, context)).toBe("retained_backup");
    expect(classifyAppBundle(`${root}/Dure-0.2.39.app-backup`, context)).toBe("retained_backup");
    expect(classifyAppBundle("/Applications/Dure.app", context)).toBe("current");
    expect(classifyAppBundle("/Users/fixture/Applications/Dure.app", context)).toBe("applications");
    expect(classifyAppBundle(`${root} Old/Dure.app`, context)).toBe("other");
    expect(classifyAppBundle("/tmp/build/Dure.app", context)).toBe("other");
  });

  it("finds the Dure copy that started this session from its process ancestry", () => {
    const backup = "/Users/fixture/Library/Application Support/Dure/App Backups/Dure-0.2.39.app";
    const processes = parseProcessTable([
      `  10     1 ${backup}/Contents/MacOS/hmux-runtime host --session s1`,
      "  11    10 /bin/zsh -l",
      "  12    11 node /Users/fixture/.local/share/hebbian-ide-cli/current/bin/dure.mjs computer type x",
      "  20     1 /Applications/Dure.app/Contents/MacOS/dure",
    ].join("\n"));
    expect(sessionRuntimeProcess(processes, 12)).toMatchObject({ processId: 10, bundlePath: backup, role: "hmux_runtime" });
    expect(sessionRuntimeProcess(processes, 20)).toMatchObject({ processId: 20, role: "app" });
    expect(sessionRuntimeProcess(processes, 99)).toBeNull();
  });

  it("prefers the responsible app macOS records over process ancestry", () => {
    const home = "/Users/fixture";
    const backup = `${retainedAppBackupsRoot(home)}/Dure-0.2.39.app`;
    const processes = parseProcessTable([
      "  10     1 /Users/fixture/.local/share/hmux/versions/0.2.26+x/bin/hmux-runtime internal-hmux-host",
      "  11    10 claude --resume",
      "  12    11 node /Users/fixture/.local/share/hebbian-ide-cli/current/bin/dure.mjs computer type x",
      `  70     1 ${backup}/Contents/MacOS/dure`,
      "  80     1 /Applications/Dure.app/Contents/MacOS/dure",
    ].join("\n"));
    const inspect = (responsibleProcessId) => inspectRuntimeIdentity({
      home,
      appProcessId: 80,
      sessionProcessId: 12,
      responsibleProcessId,
      processes,
      platform: "darwin",
      readFile: () => { throw new Error("no Info.plist"); },
      readdir: () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); },
    });
    expect(inspect(70).session).toEqual({
      processId: 70,
      role: "app",
      attribution: "responsible_process",
      bundlePath: backup,
      version: null,
      location: "retained_backup",
    });
    // A responsible process outside Dure (or gone) leaves only ancestry, which
    // finds no Dure bundle for a host that runs from its own install.
    expect(inspect(4242).session).toBeNull();
    expect(inspect(null).session).toBeNull();
    expect(inspect(80).session).toMatchObject({ processId: 80, location: "current" });
  });

  it("reads the responsible process through JXA only on macOS", () => {
    const run = vi.fn(() => ({ status: 0, stdout: "1074\n" }));
    expect(readResponsibleProcessId(12, { run, platform: "linux" })).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(readResponsibleProcessId(12, { run, platform: "darwin" })).toBe(1074);
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", expect.stringContaining("responsibility_get_pid_responsible_for_pid"), "12"],
      expect.any(Object),
    );
    expect(readResponsibleProcessId(12, { run: () => ({ status: 0, stdout: "-1\n" }), platform: "darwin" })).toBeNull();
    expect(readResponsibleProcessId(12, { run: () => { throw new Error("stubbed"); }, platform: "darwin" })).toBeNull();
  });

  it("reads the process table only on macOS", () => {
    const run = vi.fn(() => ({ status: 0, stdout: "  7 1 /bin/zsh\n" }));
    expect(readProcessTable({ run, platform: "linux" })).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(readProcessTable({ run, platform: "darwin" })).toEqual([{ pid: 7, parentPid: 1, command: "/bin/zsh" }]);
    expect(run).toHaveBeenCalledWith("/bin/ps", ["-axo", "pid=,ppid=,command="], expect.any(Object));
    expect(readProcessTable({ run: () => ({ status: 1, stdout: "" }), platform: "darwin" })).toBeNull();
  });
});

describe("retained Dure app backups", () => {
  function backupFixture() {
    const home = temporaryHome();
    const root = retainedAppBackupsRoot(home);
    const idle = writeBundle(path.join(root, "Dure-0.2.39-10b6a2f25ee5-20260927.app"));
    const running = writeBundle(path.join(root, "Dure-0.2.40-4ef593bca066-20260927.app"), { version: "0.2.40" });
    const inert = writeBundle(path.join(root, "Dure-0.2.38-0123456789ab-20260920.app-backup"), { version: "0.2.38" });
    writeBundle(path.join(root, "Other.app"), { identifier: "com.example.other" });
    fs.writeFileSync(path.join(root, "notes.txt"), "not a bundle\n");
    fs.symlinkSync(idle, path.join(root, "Linked.app"));
    const processes = parseProcessTable([
      `  30     1 ${running}/Contents/MacOS/hmux-runtime host --session s2`,
      "  31    30 /bin/zsh -l",
      "  32    31 codex",
    ].join("\n"));
    return { home, root, idle, running, inert, processes };
  }

  it("reports which Dure backups are still launchable and which run processes", () => {
    const { home, root, processes } = backupFixture();
    expect(inspectRetainedAppBackups({ home, processes })).toEqual({
      root,
      state: "present",
      entries: [
        expect.objectContaining({ name: "Dure-0.2.38-0123456789ab-20260920.app-backup", state: "inert", processIds: [] }),
        expect.objectContaining({ name: "Dure-0.2.39-10b6a2f25ee5-20260927.app", state: "launchable", version: "0.2.39" }),
        expect.objectContaining({ name: "Dure-0.2.40-4ef593bca066-20260927.app", state: "in_use", processIds: [30] }),
      ],
    });
    expect(inspectRetainedAppBackups({ home, processes: null }).entries.map((entry) => entry.state))
      .toEqual(["inert", "unknown", "unknown"]);
    expect(inspectRetainedAppBackups({ home: temporaryHome(), processes }).state).toBe("absent");
  });

  it("renames idle .app backups so LaunchServices no longer treats them as apps", () => {
    const { home, root, idle, running, processes } = backupFixture();
    const calls = [];
    const unregister = vi.fn((bundlePath) => {
      calls.push(["unregister", bundlePath, fs.existsSync(bundlePath)]);
      return true;
    });
    const outcome = makeRetainedAppBackupsInert({ home, processes, unregister });
    const inertPath = path.join(root, "Dure-0.2.39-10b6a2f25ee5-20260927.app-backup");
    expect(outcome.entries).toEqual([
      { name: "Dure-0.2.38-0123456789ab-20260920.app-backup", state: "inert", processIds: [] },
      {
        name: "Dure-0.2.39-10b6a2f25ee5-20260927.app",
        state: "made_inert",
        inertName: "Dure-0.2.39-10b6a2f25ee5-20260927.app-backup",
        launchServices: "unregistered",
        processIds: [],
      },
      { name: "Dure-0.2.40-4ef593bca066-20260927.app", state: "in_use", processIds: [30] },
    ]);
    // Unregistered at the registered path, before the rename.
    expect(calls).toEqual([["unregister", idle, true]]);
    expect(fs.existsSync(idle)).toBe(false);
    expect(fs.readFileSync(path.join(inertPath, "Contents", "MacOS", "dure"), "utf8")).toBe("fixture executable\n");
    // A copy that still runs a session keeps every executable path it uses.
    expect(fs.existsSync(path.join(running, "Contents", "MacOS", "dure"))).toBe(true);
    // Unrelated bundles, files and links are left alone.
    expect(fs.existsSync(path.join(root, "Other.app"))).toBe(true);
    expect(fs.readFileSync(path.join(root, "notes.txt"), "utf8")).toBe("not a bundle\n");
    expect(fs.lstatSync(path.join(root, "Linked.app")).isSymbolicLink()).toBe(true);

    const again = makeRetainedAppBackupsInert({ home, processes, unregister });
    expect(again.entries.map((entry) => entry.state)).toEqual(["inert", "inert", "in_use"]);
    expect(unregister).toHaveBeenCalledTimes(1);

    const afterExit = makeRetainedAppBackupsInert({ home, processes: [], unregister });
    expect(afterExit.entries.map((entry) => entry.state)).toEqual(["inert", "inert", "made_inert"]);
    expect(fs.existsSync(path.join(root, "Dure-0.2.40-4ef593bca066-20260927.app-backup"))).toBe(true);
  });

  it("never replaces an existing inert copy and never renames without a process census", () => {
    const { home, root, idle } = backupFixture();
    const unregister = vi.fn(() => true);
    expect(makeRetainedAppBackupsInert({ home, processes: null, unregister }).entries.map((entry) => entry.state))
      .toEqual(["inert", "unknown", "unknown"]);
    expect(unregister).not.toHaveBeenCalled();
    const occupied = writeBundle(path.join(root, "Dure-0.2.39-10b6a2f25ee5-20260927.app-backup"), { version: "0.2.39-kept" });
    const outcome = makeRetainedAppBackupsInert({ home, processes: [], unregister });
    expect(outcome.entries.find((entry) => entry.name.endsWith("20260927.app") && entry.name.includes("0.2.39")))
      .toEqual({ name: "Dure-0.2.39-10b6a2f25ee5-20260927.app", state: "conflict", processIds: [] });
    expect(fs.existsSync(idle)).toBe(true);
    expect(fs.readFileSync(path.join(occupied, "Contents", "Info.plist"), "utf8")).toContain("0.2.39-kept");
  });

  it("skips the process census when there is no backups folder and never throws at startup", () => {
    const readProcesses = vi.fn(() => []);
    expect(reconcileRetainedAppBackups({ home: temporaryHome(), readProcesses })).toMatchObject({ state: "absent" });
    expect(readProcesses).not.toHaveBeenCalled();
    const { home } = backupFixture();
    expect(reconcileRetainedAppBackups({
      home,
      readProcesses: () => { throw new Error("ps unavailable"); },
    })).toEqual({ schemaVersion: 1, state: "failed", message: "ps unavailable" });
  });

  it("refuses to publish shared integration files from a retained backup", () => {
    const home = "/Users/fixture";
    const root = retainedAppBackupsRoot(home);
    expect(() => assertNotRetainedAppBackup({
      home,
      sourcePath: `${root}/Dure-0.2.39.app/Contents/Resources/resources/dure-cli/versions/0.2.39+x`,
    })).toThrow(/refusing to publish shared Dure integration files from a retained app backup/);
    expect(() => assertNotRetainedAppBackup({
      home,
      sourcePath: "/Applications/Dure.app/Contents/Resources/resources/dure-cli/versions/0.2.49+x",
    })).not.toThrow();
    expect(() => assertNotRetainedAppBackup({ home, sourcePath: "/tmp/build/dure-cli/versions/0.2.49+x" })).not.toThrow();
  });
});

describe("creating a retained Dure app backup", () => {
  function installedFixture(home) {
    const installed = writeBundle(path.join(home, "Applications", "Dure.app"), { version: "0.2.49" });
    const metadata = path.join(installed, "Contents", "Resources", "resources", "dure-cli", "current");
    fs.mkdirSync(metadata, { recursive: true });
    fs.writeFileSync(path.join(metadata, "install.json"), JSON.stringify({
      bundle: { app: { schemaVersion: 2, channel: "stable", sourceRevision: "2904920e51812b3d00818d1b8a6292d700a2925b" } },
    }));
    return installed;
  }
  const copy = (source, target) => fs.cpSync(source, target, { recursive: true });
  const now = new Date("2026-10-17T09:00:00Z");

  it("stores the copy in a form LaunchServices does not treat as an application", () => {
    const home = temporaryHome();
    const installed = installedFixture(home);
    const receipt = retainAppBackup({ home, appBundle: installed, now, copy });
    const root = retainedAppBackupsRoot(home);
    expect(receipt).toEqual({
      schemaVersion: 1,
      source: installed,
      path: path.join(root, "Dure-0.2.49-2904920e5181-20261017.app-backup"),
      version: "0.2.49",
    });
    expect(fs.readdirSync(root)).toEqual(["Dure-0.2.49-2904920e5181-20261017.app-backup"]);
    expect(fs.readFileSync(path.join(receipt.path, "Contents", "MacOS", "dure"), "utf8")).toBe("fixture executable\n");
    expect(enclosingAppBundle(path.join(receipt.path, "Contents", "MacOS", "dure"))).toBe(receipt.path);
    expect(inspectRetainedAppBackups({ home, processes: [] }).entries)
      .toEqual([expect.objectContaining({ name: path.basename(receipt.path), state: "inert" })]);
    // The installed app is copied, never moved.
    expect(fs.existsSync(path.join(installed, "Contents", "MacOS", "dure"))).toBe(true);
  });

  it("never replaces an earlier copy and refuses a bundle that is not Dure", () => {
    const home = temporaryHome();
    const installed = installedFixture(home);
    const first = retainAppBackup({ home, appBundle: installed, now, copy });
    fs.writeFileSync(path.join(first.path, "kept"), "first copy\n");
    const second = retainAppBackup({ home, appBundle: installed, now, copy });
    expect(path.basename(second.path)).toBe("Dure-0.2.49-2904920e5181-20261017-2.app-backup");
    expect(fs.readFileSync(path.join(first.path, "kept"), "utf8")).toBe("first copy\n");
    const other = writeBundle(path.join(home, "Other.app"), { identifier: "com.example.other" });
    expect(() => retainAppBackup({ home, appBundle: other, now, copy })).toThrow(/is not a Dure app bundle/);
    const failingCopy = (source, target) => {
      copy(source, target);
      throw new Error("disk full");
    };
    expect(() => retainAppBackup({ home, appBundle: installed, now, copy: failingCopy })).toThrow("disk full");
    expect(fs.readdirSync(retainedAppBackupsRoot(home)).sort()).toEqual([
      "Dure-0.2.49-2904920e5181-20261017-2.app-backup",
      "Dure-0.2.49-2904920e5181-20261017.app-backup",
    ]);
  });

  it.skipIf(process.platform !== "darwin")("copies with ditto by default", () => {
    const home = temporaryHome();
    const receipt = retainAppBackup({ home, appBundle: installedFixture(home), now });
    expect(fs.readFileSync(path.join(receipt.path, "Contents", "Info.plist"), "utf8")).toContain("0.2.49");
    expect(fs.existsSync(`${receipt.path}.partial`)).toBe(false);
  });
});

describe("runtime identity diagnostics", () => {
  function identityFixture() {
    const home = temporaryHome();
    const installed = writeBundle(path.join(home, "Applications-fixture", "Dure.app"), { version: "0.2.49" });
    const backup = writeBundle(path.join(retainedAppBackupsRoot(home), "Dure-0.2.39-10b6a2f25ee5-20260927.app"));
    const processes = parseProcessTable([
      `  20     1 ${installed}/Contents/MacOS/dure`,
      `  21     1 ${installed}/Contents/MacOS/hmux-runtime host --session current`,
      `  40     1 ${backup}/Contents/MacOS/hmux-runtime host --session lane`,
      "  41    40 /bin/zsh -l",
      `  42    41 ${backup}/${CONTROL_PLANE} codex-native-driver --runtime /x -- codex`,
      "  43    42 codex --yolo",
      "  44    41 node /fixture/.local/share/hebbian-ide-cli/current/bin/dure.mjs diagnostics",
    ].join("\n"));
    const identity = inspectRuntimeIdentity({
      home,
      appProcessId: 20,
      sessionProcessId: 44,
      processes,
      platform: "darwin",
      installedAppBundle: path.join(home, "missing", "Dure.app"),
    });
    return { home, installed, backup, identity };
  }

  it("names the app copy, this session's copy and every other live copy", () => {
    const { installed, backup, identity } = identityFixture();
    expect(identity).toMatchObject({
      state: "available",
      currentBundlePath: installed,
      app: { processId: 20, bundlePath: installed, version: "0.2.49", location: "other" },
      session: {
        processId: 40,
        role: "hmux_runtime",
        attribution: "process_ancestry",
        bundlePath: backup,
        version: "0.2.39",
        location: "retained_backup",
      },
      otherBundles: [{
        bundlePath: backup,
        version: "0.2.39",
        location: "retained_backup",
        processes: [
          { processId: 40, role: "hmux_runtime", descendantCount: 4, descendantCommands: ["zsh", "node", "codex"] },
          { processId: 42, role: "provider_driver", descendantCount: 1, descendantCommands: ["codex"] },
        ],
      }],
      retainedBackups: { state: "present", entries: [expect.objectContaining({ state: "in_use", processIds: [40, 42] })] },
    });
    expect(inspectRuntimeIdentity({ home: "/x", processes: [], platform: "linux" }))
      .toEqual({ schemaVersion: 1, state: "unsupported_platform" });
  });

  it("explains the affected sessions before any restart advice", () => {
    const { backup, installed, identity } = identityFixture();
    const report = createDiagnosticReport({
      cli: { packageVersion: "0.2.49", pathMatchesCurrent: true },
      app: { state: "running", packageVersion: "0.2.49", compatibility: { state: "available", mode: "current" } },
      hmux: { compatible: true },
      runtimeIdentity: identity,
      selectedChannel: "stable",
    });
    expect(report.status).toBe("degraded");
    expect(report.issues).toEqual([
      "session_runtime_not_current",
      "runtime_processes_not_current",
      "retained_app_backup_launchable",
    ]);
    const steps = report.recovery.steps.join("\n");
    expect(steps).toContain(`This terminal's session was started by ${backup} (Dure 0.2.39) [retained_backup], not by ${installed}`);
    expect(steps).toContain("granting them to the installed app or restarting the app does not change it");
    expect(steps).toContain("pid 40 hmux_runtime (zsh, node, codex); pid 42 provider_driver (codex)");
    expect(steps).toContain("do not stop processes you do not own");
    expect(report.recovery.steps.findIndex((step) => step.includes("This terminal's session")))
      .toBeLessThan(report.recovery.steps.findIndex((step) => step.startsWith("An unreachable app")));
    const text = formatDiagnosticReport(report);
    expect(text).toContain(`  app_bundle: ${installed} (0.2.49) [other] pid 20`);
    expect(text).toContain(`  session_bundle: ${backup} (0.2.39) [retained_backup] via hmux_runtime pid 40 (process_ancestry)`);
    expect(text).toContain("    - pid 42 provider_driver: 1 descendants (codex)");
    expect(text).toContain("    - Dure-0.2.39-10b6a2f25ee5-20260927.app: in_use pids 40,42");
  });

  it("flags shared hook scripts that still execute another copy", () => {
    const home = temporaryHome();
    const control = path.join(home, ".dure");
    fs.mkdirSync(control, { recursive: true });
    const installed = writeBundle(path.join(home, "Applications", "Dure.app"), { version: "0.2.49" });
    const deleted = path.join(retainedAppBackupsRoot(home), "Dure-0.2.39-10b6a2f25ee5-20260927.app");
    fs.writeFileSync(
      path.join(control, "managed-claude-hook-v2.sh"),
      `#!/bin/sh\nexec '${deleted}/${CONTROL_PLANE}' managed-claude-hook\n`,
    );
    fs.writeFileSync(
      path.join(control, "managed-codex-native.sh"),
      `#!/bin/sh\nexec '${installed}/${CONTROL_PLANE}' codex-native-driver --runtime '/x' -- "$1"\n`,
    );
    const identity = inspectRuntimeIdentity({
      home,
      appProcessId: 20,
      processes: parseProcessTable(`  20     1 ${installed}/Contents/MacOS/dure\n`),
      controlDirectory: control,
      platform: "darwin",
      installedAppBundle: path.join(home, "missing", "Dure.app"),
    });
    expect(identity.integrationFiles).toEqual([
      {
        name: "managed-claude-hook-v2.sh",
        path: path.join(control, "managed-claude-hook-v2.sh"),
        bundlePath: deleted,
        location: "retained_backup",
        exists: false,
      },
      {
        name: "managed-codex-native.sh",
        path: path.join(control, "managed-codex-native.sh"),
        bundlePath: installed,
        location: "current",
        exists: true,
      },
    ]);
    const findings = runtimeIdentityFindings(identity);
    expect(findings.issues).toEqual(["integration_files_not_current"]);
    expect(findings.steps[0]).toContain(
      `Shared hook scripts managed-claude-hook-v2.sh run executables from ${deleted} [retained_backup, missing], not from ${installed}.`,
    );
    expect(findings.steps[0]).toContain("Managed sessions keep running across the restart");
    const report = createDiagnosticReport({
      cli: { packageVersion: "0.2.49", pathMatchesCurrent: true },
      app: { state: "running", packageVersion: "0.2.49", compatibility: { state: "available", mode: "current" } },
      hmux: { compatible: true },
      runtimeIdentity: identity,
    });
    expect(formatDiagnosticReport(report)).toContain(
      `  integration_file: managed-claude-hook-v2.sh -> ${deleted} [retained_backup] (missing)`,
    );
  });

  it("flags an app that itself runs from a retained backup", () => {
    const home = "/Users/fixture";
    const backup = `${retainedAppBackupsRoot(home)}/Dure-0.2.39.app`;
    const findings = runtimeIdentityFindings({
      state: "available",
      currentBundlePath: backup,
      app: { processId: 5, bundlePath: backup, version: "0.2.39", location: "retained_backup" },
      session: null,
      otherBundles: [],
      retainedBackups: { root: retainedAppBackupsRoot(home), state: "present", entries: [] },
    });
    expect(findings.issues).toEqual(["app_running_from_retained_backup"]);
    expect(findings.steps[0]).toContain("Managed sessions keep running when the app quits");
    expect(runtimeIdentityFindings(null)).toEqual({ issues: [], steps: [] });
  });

  it("names the Dure copy macOS checks for a permission failure", () => {
    const { backup, installed, identity } = identityFixture();
    expect(permissionAttributionHint(identity)).toBe(
      `macOS checks this permission against the Dure copy that started this session: ${backup} (Dure 0.2.39). ` +
        `That copy is a retained backup, not the installed app, so access granted to ${installed} does not apply here. ` +
        "This session keeps running; start a new session from the installed app for desktop control instead of restarting the app.",
    );
    expect(permissionAttributionHint({ ...identity, session: { ...identity.session, location: "current" } }))
      .toBe(`macOS checks this permission against the Dure copy that started this session: ${backup} (Dure 0.2.39).`);
    expect(permissionAttributionHint({ ...identity, session: null })).toBeNull();
  });
});

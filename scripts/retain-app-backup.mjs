#!/usr/bin/env node
// Keep a copy of the installed Dure app for an explicit rollback before
// replacing it. The copy is stored as `<name>.app-backup` under
// ~/Library/Application Support/Dure/App Backups, which LaunchServices does
// not treat as an application, so it can never be launched by bundle id.
//
// Usage: node scripts/retain-app-backup.mjs [path/to/Dure.app]

import { homedir } from "node:os";
import { retainAppBackup } from "../cli/lib/retained-app-backups.mjs";

const [appBundle, ...extra] = process.argv.slice(2);
if (process.platform !== "darwin" || extra.length > 0 || appBundle?.startsWith("-")) {
  process.stderr.write("usage (macOS): node scripts/retain-app-backup.mjs [path/to/Dure.app]\n");
  process.exit(2);
}
try {
  const receipt = retainAppBackup({ home: homedir(), ...(appBundle ? { appBundle } : {}) });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} catch (error) {
  process.stderr.write(`retain-app-backup: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

/** Full app + production terminal over the existing synthetic demo transport.
 * Run through test:wide; no native bridge, user data, or live session is used. */
import "../src/styles.css";
import { startApp } from "../src/app";
import { ipc } from "../src/ipc";
import { decodeTerminalStateRecord } from "@/lib/terminal/protocol/terminalStateProtocol";
import { DEFAULT_SETTINGS_PREFERENCES, saveSettingsPreferences } from "../src/settingsPreferences";

if (import.meta.env.VITE_DURE_DEMO !== "1") throw new Error("Wide QA requires the demo transport");
saveSettingsPreferences({ ...DEFAULT_SETTINGS_PREFERENCES, language: "en", haptics: false });

const evidence = {
  attachments: [] as string[],
  detaches: [] as (string | undefined)[],
  inputs: [] as { attachment: string; kind: string; text?: string; key?: string }[],
  resizes: [] as { attachment: string; columns: number; rows: number }[],
  frames: [] as { attachment: string; followTail: boolean }[],
  catalogRevision: 0,
};
const original = { ...ipc };
ipc.attachHubSession = async (...args) => {
  const attached = await original.attachHubSession(...args);
  evidence.attachments.push(attached.terminal.attachment_id);
  return attached;
};
ipc.detachSession = async id => {
  evidence.detaches.push(id);
  return original.detachSession(id);
};
ipc.sendTerminalRecord = (attachment, bytes) => {
  const body = decodeTerminalStateRecord(bytes).record.body;
  if (body.case === "inputIntent") {
    const intent = body.value.intent;
    if (intent.case === "resize") evidence.resizes.push({ attachment, columns: intent.value.columns, rows: intent.value.rows });
    else evidence.inputs.push({ attachment, kind: intent.case ?? "unknown",
      ...(intent.case === "text" || intent.case === "paste" ? { text: new TextDecoder().decode(intent.value.utf8) } : {}),
      ...(intent.case === "key" ? { key: intent.value.key } : {}),
    });
  }
  return original.sendTerminalRecord(attachment, bytes);
};
ipc.nextTerminalRecord = async attachment => {
  const bytes = await original.nextTerminalRecord(attachment);
  // Runtime observations are JSON control records, not terminal frames.
  if (new Uint8Array(bytes)[0] !== 123) {
    const body = decodeTerminalStateRecord(new Uint8Array(bytes)).record.body;
    if (body.case === "viewportFrame") evidence.frames.push({ attachment, followTail: body.value.followTail });
  }
  return bytes;
};
ipc.hubOpen = async id => {
  const result = await original.hubOpen(id);
  if (!evidence.catalogRevision) return result;
  return { ...result, sessions: result.sessions.map(session => ({ ...session,
    session_name: `${session.session_name} · refreshed ${evidence.catalogRevision}`,
  })) };
};
Object.assign(window, { wideQA: evidence });
const dispose = startApp(document.querySelector<HTMLElement>("#root")!);
window.addEventListener("pagehide", dispose, { once: true });
import.meta.hot?.dispose(dispose);

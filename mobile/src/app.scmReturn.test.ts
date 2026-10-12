import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { decodeTerminalStateRecord } from "@/lib/terminal/protocol/terminalStateProtocol";
import { viewportFrameRecord } from "@/test/terminalRecordFixtures";
import { startApp } from "./app";

const transport = vi.hoisted(() => ({
	attaches: 0,
	width: 360,
	title: "QA SCM",
	reads: 0,
	holdInitial: false,
	pending: undefined as ((record: ArrayBuffer) => void) | undefined,
	sent: [] as Uint8Array[],
	detach: vi.fn(),
	beforeAttach: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-barcode-scanner", () => ({
	checkPermissions: async () => "denied",
}));
vi.mock("@tauri-apps/api/core", () => ({
	invoke: async (command: string, args: Record<string, unknown>) => {
		const session = {
			session_id: "qa-scm",
			session_name: transport.title,
			workspace_id: "qa",
			session_class: "standalone",
			lifecycle: "ready",
			provider_id: "shell",
			runner_principal: "qa",
			runner_instance: "runner-qa",
			channel_epoch: "1",
			host_instance_id: "host-qa",
			terminal_epoch: "epoch-qa",
			capabilities: ["terminal_surface_v1"],
			ready: true,
		};
		switch (command) {
			case "list_servers":
				return { version: 3, servers: [] };
			case "hub_list":
				return [
					{
						id: "qa-hub",
						box_label: "QA",
						endpoint: "127.0.0.1:1",
						relay_offered: true,
					},
				];
			case "hub_layouts":
				return {};
			case "take_session_census":
				return [];
			case "hub_open":
				return {
					id: "qa-hub",
					box_label: "QA",
					sessions: [session, { ...session, session_id: "qa-next", session_name: "Next session" }]
						.map(row => ({ ...row, box_id: "qa-box", box_label: "QA" })),
					unreachable: [],
				};
			case "attach_hub_session":
				transport.attaches++;
				await transport.beforeAttach();
				return {
					session_id: (args.session as typeof session).session_id,
					attestation: "relayed",
					role: "controller",
					granted_capabilities: ["terminal_surface_v1"],
					withheld_over_relay: [],
					terminal: {
						attachment_id: transport.attaches === 1 ? "attach-scm" : "attach-next",
						terminal_epoch: "epoch-qa",
						through_output_seq: "1",
						state_revision: "1",
						initial_delivery_record_count: 1,
					},
				};
			case "next_terminal_record": {
				transport.reads += 1;
				if (transport.reads === 1 && !transport.holdInitial)
					return frame("ready-before-scm", 1n);
				return new Promise<ArrayBuffer>((resolve) => {
					transport.pending = resolve;
				});
			}
			case "send_terminal_record":
				transport.sent.push(Uint8Array.from(args.record as number[]));
				return null;
			case "detach_session":
				return transport.detach(args.attachmentId);
			case "hub_git_status":
				return {
					read: true,
					branch: "main",
					files_read: true,
					files: [
						{
							path: "qa.txt",
							status: "?",
							added: 1,
							deleted: 0,
							old_path: null,
							uncommitted: true,
						},
					],
					ahead: 0,
					behind: 0,
					base_ref: "main",
					code: null,
					detail: null,
				};
			case "hub_file_diff":
				return {
					read: true,
					path: "qa.txt",
					patch: "@@ -0,0 +1 @@\n+qa\n",
					binary: false,
					truncated: false,
					added: 1,
					deleted: 0,
					code: null,
					detail: null,
				};
			case "device_identity_status":
				return {
					state: "not_provisioned",
					reason: "QA",
					planned_algorithm: "ecdsa-sha2-nistp256",
				};
			default:
				throw new Error(`Unexpected QA command: ${command}`);
		}
	},
}));

function frame(text: string, revision: bigint): ArrayBuffer {
	const record = viewportFrameRecord({
		terminalEpoch: "epoch-qa",
		stateRevision: revision,
		throughOutputSeq: revision,
		projectionRevision: revision,
		texts: [text],
	});
	return record.buffer.slice(
		record.byteOffset,
		record.byteOffset + record.byteLength,
	) as ArrayBuffer;
}

let dispose: (() => void) | undefined;
beforeEach(() => {
	localStorage.clear();
	transport.attaches = 0;
	transport.width = 360;
	transport.title = "QA SCM";
	transport.reads = 0;
	transport.holdInitial = false;
	transport.pending = undefined;
	transport.sent = [];
	transport.detach.mockReset();
	transport.beforeAttach.mockReset();
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
	vi.spyOn(window, "scrollTo").mockImplementation(() => {});
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
		function (this: HTMLElement) {
			return this.isConnected ? transport.width : 0;
		},
	);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
		function (this: HTMLElement) {
			return this.isConnected ? 600 : 0;
		},
	);
});
afterEach(() => {
	dispose?.();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function pick<T extends HTMLElement>(selector: string): T {
	const node = document.querySelector<T>(selector);
	if (!node) throw new Error(`Missing ${selector}`);
	return node;
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}
async function openTerminal(): Promise<HTMLElement> {
	const root = document.createElement("div");
	document.body.replaceChildren(root);
	dispose = startApp(root);
	await vi.waitFor(() =>
		expect(document.querySelector(".list__open")).not.toBeNull(),
	);
	const row = [...root.querySelectorAll<HTMLButtonElement>(".list__open")]
		.find(button => button.textContent?.includes(transport.title));
	if (!row) throw new Error("Missing QA session");
	row.click();
	await vi.waitFor(() =>
		expect(root.textContent).toContain("ready-before-scm"),
	);
	await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThan(0));
	return pick(".session__terminal");
}

// QA606: both native and on-screen Back returned to an empty terminal after Git.
it("keeps the existing transcript and reader through Source control and back", async () => {
	const terminal = await openTerminal();
	pick<HTMLButtonElement>(".session__icon--connection").click();
	await vi.waitFor(() =>
		expect(document.querySelector(".scm__file")).not.toBeNull(),
	);
	pick<HTMLButtonElement>(".scm .session__header .icon-tap").click();
	expect(pick(".session__terminal")).toBe(terminal);
	expect(terminal.textContent).toContain("ready-before-scm");
	expect(transport.reads).toBe(2);
	expect(transport.detach).not.toHaveBeenCalled();
});

it("continues one reader under a nested diff without publishing hidden geometry", async () => {
	const terminal = await openTerminal();
	const resizes = () =>
		transport.sent.filter((r) => {
			const body = decodeTerminalStateRecord(r).record.body;
			return body.case === "inputIntent" && body.value.intent.case === "resize";
		}).length;
	const resizeCount = resizes();
	pick<HTMLButtonElement>(".session__icon--connection").click();
	await vi.waitFor(() =>
		expect(document.querySelector(".scm__file")).not.toBeNull(),
	);
	pick<HTMLButtonElement>(".scm__file button").click();
	await vi.waitFor(() =>
		expect(document.querySelector("h1")?.textContent).toBe("qa.txt"),
	);
	transport.pending?.(frame("arrived-under-diff", 2n));
	await vi.waitFor(() =>
		expect(terminal.textContent).toContain("arrived-under-diff"),
	);
	expect(resizes()).toBe(resizeCount);
	pick<HTMLButtonElement>(".scm .session__header .icon-tap").click();
	pick<HTMLButtonElement>(".scm .session__header .icon-tap").click();
	expect(pick(".session__terminal")).toBe(terminal);
	expect(terminal.textContent).toContain("arrived-under-diff");
	expect(transport.reads).toBe(3);
});

it("waits for visible geometry when the initial viewport arrives under Git", async () => {
	transport.holdInitial = true;
	const root = document.createElement("div");
	document.body.replaceChildren(root);
	dispose = startApp(root);
	await vi.waitFor(() =>
		expect(document.querySelector(".list__open")).not.toBeNull(),
	);
	pick<HTMLButtonElement>(".list__open").click();
	await vi.waitFor(() => expect(transport.pending).toBeTypeOf("function"));
	const terminal = pick(".session__terminal");
	pick<HTMLButtonElement>(".session__icon--connection").click();
	await vi.waitFor(() =>
		expect(document.querySelector(".scm__file")).not.toBeNull(),
	);
	transport.pending?.(frame("initial-under-git", 1n));
	await vi.waitFor(() =>
		expect(terminal.textContent).toContain("initial-under-git"),
	);
	expect(transport.sent).toHaveLength(0);
	pick<HTMLButtonElement>(".scm .session__header .icon-tap").click();
	await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
	const body = decodeTerminalStateRecord(transport.sent[0]!).record.body;
	expect(body.case).toBe("inputIntent");
	if (body.case !== "inputIntent" || body.value.intent.case !== "resize")
		throw new Error("Expected resize");
	expect(body.value.intent.value.columns).toBeGreaterThan(1);
});

it("restores a reader's scroll position across detached Git renders", async () => {
	const terminal = await openTerminal();
	terminal.scrollTop = 120;
	terminal.scrollLeft = 212;
	terminal.dispatchEvent(new Event("scroll"));
	pick<HTMLButtonElement>(".session__icon--connection").click();
	// Real WebViews clear detached nodes' scroll offsets; jsdom does not.
	terminal.scrollTop = 0;
	terminal.scrollLeft = 0;
	terminal.dispatchEvent(new Event("scroll"));
	await vi.waitFor(() =>
		expect(document.querySelector(".scm__file")).not.toBeNull(),
	);
	pick<HTMLButtonElement>(".scm .session__header .icon-tap").click();
	await vi.waitFor(() => expect(terminal.scrollTop).toBe(120));
	expect(terminal.scrollLeft).toBe(212);
	pick<HTMLButtonElement>(".session__header .icon-tap").click();
	await vi.waitFor(() =>
		expect(document.querySelector(".session__terminal")).toBeNull(),
	);
	expect(transport.detach).toHaveBeenCalledOnce();
	expect(terminal.textContent).toBe("");
});

it("does not forget an unsent command when Git covers its session", async () => {
	await openTerminal();
	const box = pick<HTMLTextAreaElement>(".tray__box");
	box.value = "unsent draft";
	box.dispatchEvent(new Event("input", { bubbles: true }));
	pick<HTMLButtonElement>(".session__icon--connection").click();
	await vi.waitFor(() =>
		expect(document.querySelector(".scm__file")).not.toBeNull(),
	);
	pick<HTMLButtonElement>(".scm .session__header .icon-tap").click();
	const field = pick(".tray__box");
	field.dispatchEvent(
		new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }),
	);
	field.dispatchEvent(new InputEvent("beforeinput", {
		inputType: "insertLineBreak", bubbles: true, cancelable: true,
	}));
	pick<HTMLButtonElement>(".tray__toggle--history").click();
	expect(pick(".history-item__text").textContent).toBe("unsent draft");
});

it("refits without replacing the attachment, reader, focused IME or history draft", async () => {
	const terminal = await openTerminal();
	const box = pick<HTMLTextAreaElement>(".tray__box");
	box.focus();
	box.value = "resize draft";
	box.dispatchEvent(new Event("input", { bubbles: true }));
	box.dispatchEvent(new CompositionEvent("compositionstart"));
	for (const width of [520, 360, 840, 704]) {
		transport.width = width;
		window.dispatchEvent(new Event("resize"));
		expect(pick(".session__terminal")).toBe(terminal);
		expect(pick(".tray__box")).toBe(box);
		expect(document.activeElement).toBe(box);
		expect(box.value).toBe("resize draft");
	}
	box.dispatchEvent(new CompositionEvent("compositionend"));
	box.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertLineBreak", cancelable: true }));
	pick<HTMLButtonElement>(".tray__toggle--history").click();
	expect(pick(".history-item__text").textContent).toBe("resize draft");
	expect(transport.attaches).toBe(1);
	expect(transport.reads).toBe(2);
	expect(transport.detach).not.toHaveBeenCalled();
	expect(terminal.textContent).toContain("ready-before-scm");
});

it("refreshes a visible sidebar without disturbing terminal input or composition", async () => {
	vi.useFakeTimers();
	vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
		return (this.classList.contains("workspace__list") ? [{}] : []) as unknown as DOMRectList;
	});
	const terminal = await openTerminal();
	const box = pick<HTMLTextAreaElement>(".tray__box");
	box.focus();
	box.dispatchEvent(new CompositionEvent("compositionstart"));
	box.value = "한";
	box.dispatchEvent(new InputEvent("input", { isComposing: true }));
	transport.title = "Updated from Host";
	await vi.advanceTimersByTimeAsync(2100);
	expect(pick(".workspace__list").textContent).toContain("Updated from Host");
	expect(pick(".session__terminal")).toBe(terminal);
	expect(pick(".tray__box")).toBe(box);
	expect(document.activeElement).toBe(box);
	expect(box.value).toBe("한");
	box.dispatchEvent(new CompositionEvent("compositionend"));
	expect(transport.attaches).toBe(1);
	expect(transport.detach).not.toHaveBeenCalled();
});

it("keeps Git sheet drafts and blocks sidebar navigation until the sheet closes", async () => {
	const terminal = await openTerminal();
	pick<HTMLButtonElement>(".session__icon--connection").click();
	await vi.waitFor(() => expect(document.querySelector(".scm__file")).not.toBeNull());
	pick<HTMLInputElement>(".scm__file .scm__check").click();
	pick<HTMLButtonElement>(".prform__footer button").click();
	expect(pick(".workspace__list").inert).toBe(true);
	const draft = pick<HTMLTextAreaElement>(".prform__textarea");
	draft.value = "commit draft";
	draft.dispatchEvent(new Event("input"));
	window.dispatchEvent(new Event("resize"));
	expect(pick(".prform__textarea")).toBe(draft);
	expect(draft.value).toBe("commit draft");
	pick<HTMLButtonElement>(".sheet .pair-button--ghost").click();
	expect(pick(".workspace__list").inert).toBe(false);
	pick<HTMLButtonElement>(".scm .session__header .icon-tap").click();
	expect(pick(".session__terminal")).toBe(terminal);
	expect(transport.attaches).toBe(1);
});

it("releases the selected attachment when the sidebar opens settings", async () => {
	await openTerminal();
	pick<HTMLButtonElement>(".workspace__list .home__settings").click();
	await vi.waitFor(() => expect(document.querySelector(".session__terminal")).toBeNull());
	expect(transport.detach).toHaveBeenCalledOnce();
});

it("detaches before pairing through the sidebar's Settings and Computers", async () => {
	const terminal = await openTerminal();
	const detached = deferred();
	transport.detach.mockReturnValueOnce(detached.promise);
	pick<HTMLButtonElement>(".workspace__list .home__settings").click();
	expect(transport.detach).toHaveBeenCalledExactlyOnceWith("attach-scm");
	expect(pick(".session__terminal")).toBe(terminal);
	expect(document.querySelector('.settings__row[data-row="computers"]')).toBeNull();
	detached.resolve();
	await vi.waitFor(() => expect(document.querySelector('.settings__row[data-row="computers"]')).not.toBeNull());
	pick<HTMLButtonElement>('.settings__row[data-row="computers"]').click();
	pick<HTMLButtonElement>(".host-settings__add").click();
	expect(document.documentElement.dataset.scan).toBe("on");
	expect(document.querySelector(".session__terminal")).toBeNull();
	expect(transport.detach).toHaveBeenCalledExactlyOnceWith("attach-scm");
});

it.each([
	["settings", "pending"], ["settings", "attached"],
	["back", "pending"], ["back", "attached"],
])("ignores delayed %s navigation after a newer session is %s", async (action, completion) => {
	await openTerminal();
	const detached = deferred();
	const attached = deferred();
	transport.detach.mockReturnValueOnce(detached.promise);
	transport.beforeAttach.mockReturnValueOnce(attached.promise);
	pick<HTMLButtonElement>(action === "settings"
		? ".workspace__list .home__settings" : ".session__header .icon-tap").click();
	pick<HTMLButtonElement>(".workspace__list .list__open:not(:disabled)").click();
	expect(transport.attaches).toBe(2);
	if (completion === "attached") {
		attached.resolve();
		await vi.waitFor(() => expect(pick(".session__header").textContent).toContain("Next session"));
	}
	detached.resolve();
	await detached.promise;
	// Let the transport and leaveTerminal continuations settle before checking
	// that the old action has not replaced the pending selection's screen.
	await new Promise(resolve => setTimeout(resolve, 0));
	const settings = document.querySelector(".settings");
	const terminal = document.querySelector(".session__terminal");
	attached.resolve();
	expect(settings).toBeNull();
	expect(terminal).not.toBeNull();
	await vi.waitFor(() => expect(pick(".session__header").textContent).toContain("Next session"));
	expect(transport.detach).toHaveBeenCalledExactlyOnceWith("attach-scm");
	expect(transport.attaches).toBe(2);
});

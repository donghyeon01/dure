import { describe, expect, it } from "vitest";
import {
	HmuxInputReceiptError,
	parseHmuxCommandInputReceipt,
	parseHmuxInitialAgentPromptReceipt,
} from "./hmuxInputReceipt";

describe("Hmux input receipt parsing", () => {
	it("parses one compound command receipt at the IPC boundary", () => {
		expect(
			parseHmuxCommandInputReceipt(
				{
					terminalEpoch: "terminal-1",
					text: { state: "written_to_pty", recordId: "7" },
					submit: { state: "written_to_pty", recordId: "8" },
				},
				{ terminalEpoch: "terminal-1", text: true, submit: true },
			),
		).toEqual({
			terminalEpoch: "terminal-1",
			text: { state: "written_to_pty", recordId: "7" },
			submit: { state: "written_to_pty", recordId: "8" },
		});
	});

	it("rejects an interleaved compound command receipt", () => {
		expect(() =>
			parseHmuxCommandInputReceipt(
				{
					terminalEpoch: "terminal-1",
					text: { state: "written_to_pty", recordId: "7" },
					submit: { state: "written_to_pty", recordId: "9" },
				},
				{ terminalEpoch: "terminal-1", text: true, submit: true },
			),
		).toThrow("input_receipt_invalid");
	});

	it("parses one atomic draft-guarded receipt only when the guard was requested", () => {
		const atomic = {
			terminalEpoch: "terminal-1",
			text: { state: "written_to_pty", recordId: "7" },
			submit: { state: "written_to_pty", recordId: "7" },
			atomic: true,
		};
		expect(
			parseHmuxCommandInputReceipt(atomic, {
				terminalEpoch: "terminal-1",
				text: true,
				submit: true,
				draftGuardRequested: true,
			}),
		).toEqual(atomic);
		expect(() =>
			parseHmuxCommandInputReceipt(atomic, {
				terminalEpoch: "terminal-1",
				text: true,
				submit: true,
			}),
		).toThrow("input_receipt_invalid");
		for (const receipt of [
			{ ...atomic, atomic: undefined },
			{ ...atomic, submit: { state: "written_to_pty", recordId: "8" } },
		]) {
			expect(() =>
				parseHmuxCommandInputReceipt(receipt, {
					terminalEpoch: "terminal-1",
					text: true,
					submit: true,
					draftGuardRequested: true,
				}),
			).toThrow("input_receipt_invalid");
		}
	});

	it("accepts ordinary records for a guarded request only when the Host says it had no guard", () => {
		const unguarded = {
			terminalEpoch: "terminal-1",
			text: { state: "written_to_pty", recordId: "7" },
			submit: { state: "written_to_pty", recordId: "8" },
			draftGuarded: false,
		};
		const expected = {
			terminalEpoch: "terminal-1",
			text: true,
			submit: true,
			draftGuardRequested: true,
		};
		expect(parseHmuxCommandInputReceipt(unguarded, expected)).toEqual(unguarded);
		expect(
			parseHmuxCommandInputReceipt(
				{
					terminalEpoch: "terminal-1",
					text: { state: "written_to_pty", recordId: "9" },
					submit: { state: "written_to_pty", recordId: "9" },
					atomic: true,
					draftGuarded: true,
				},
				expected,
			),
		).toMatchObject({ atomic: true, draftGuarded: true });
		for (const receipt of [
			{ ...unguarded, draftGuarded: undefined },
			{ ...unguarded, draftGuarded: true },
			{ ...unguarded, atomic: true },
		]) {
			expect(() => parseHmuxCommandInputReceipt(receipt, expected)).toThrow(
				"input_receipt_invalid",
			);
		}
		expect(() =>
			parseHmuxCommandInputReceipt(unguarded, {
				terminalEpoch: "terminal-1",
				text: true,
				submit: true,
			}),
		).toThrow("input_receipt_invalid");
	});

	it("returns a typed boundary error when a requested submit receipt is missing", () => {
		try {
			parseHmuxCommandInputReceipt(
				{
					terminalEpoch: "terminal-1",
					text: { state: "written_to_pty", recordId: "7" },
				},
				{ terminalEpoch: "terminal-1", text: true, submit: true },
			);
			throw new Error("expected receipt parsing to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(HmuxInputReceiptError);
			expect(error).toMatchObject({ code: "input_receipt_invalid" });
		}
	});

	it.each([
		{
			terminalEpoch: "terminal-1",
			recordId: "7",
			inputBaselineOutputSequence: "0",
			initialAgentRuntimeRevision: "3",
		},
		{
			terminalEpoch: "terminal-1",
			recordId: "8",
			inputBaselineOutputSequence: "0",
		},
	])(
		"parses a Host prompt proof with an optional runtime revision",
		(receipt) => {
			expect(parseHmuxInitialAgentPromptReceipt(receipt, "terminal-1")).toEqual(
				receipt,
			);
		},
	);

	it.each([
		{ terminalEpoch: "terminal-2" },
		{ recordId: "0" },
		{ recordId: "07" },
		{ inputBaselineOutputSequence: "-1" },
		{ initialAgentRuntimeRevision: "0" },
	])("rejects an incomplete or mismatched Host prompt proof", (patch) => {
		const receipt = {
			terminalEpoch: "terminal-1",
			recordId: "7",
			inputBaselineOutputSequence: "0",
			initialAgentRuntimeRevision: "3",
			...patch,
		};
		expect(() =>
			parseHmuxInitialAgentPromptReceipt(receipt, "terminal-1"),
		).toThrow("hmux_initial_agent_prompt_receipt_invalid");
	});
});

import {
	isCanonicalDecimalString,
	isImmediateCanonicalDecimalSuccessor,
} from "@/lib/decimalString";
import type {
	HmuxCommandInputReceipt,
	HmuxInitialAgentPromptReceipt,
	HmuxSemanticInputReceipt,
} from "./hmuxContracts";

export class HmuxInputReceiptError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = "HmuxInputReceiptError";
	}
}

export class HmuxInputPreDispatchError extends Error {
	readonly deliveryState = "not_written";

	constructor(readonly code: string) {
		super(code);
		this.name = "HmuxInputPreDispatchError";
	}
}

function invalidReceipt(code: string): never {
	throw new HmuxInputReceiptError(code);
}

function semanticInputReceipt(
	value: unknown,
): HmuxSemanticInputReceipt | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object") {
		invalidReceipt("input_receipt_invalid");
	}
	const receipt = value as Record<string, unknown>;
	if (
		receipt.state !== "written_to_pty" ||
		!isCanonicalDecimalString(receipt.recordId) ||
		receipt.recordId === "0"
	) {
		invalidReceipt("input_receipt_invalid");
	}
	return {
		state: "written_to_pty",
		recordId: receipt.recordId,
	};
}

/** A draft-guarded request comes back as one atomic Host record, or, from a
 * Host without the guard, as ordinary text-then-submit records marked
 * `draftGuarded: false`. An ordinary request keeps its separate records. */
export function parseHmuxCommandInputReceipt(
	value: unknown,
	expected: {
		terminalEpoch?: string;
		text: boolean;
		submit: boolean;
		draftGuardRequested?: boolean;
	},
): HmuxCommandInputReceipt {
	if (!value || typeof value !== "object") {
		invalidReceipt("input_receipt_invalid");
	}
	const receipt = value as Record<string, unknown>;
	const text = semanticInputReceipt(receipt.text);
	const submit = semanticInputReceipt(receipt.submit);
	const guardRequested = expected.draftGuardRequested === true;
	const atomic = guardRequested && receipt.draftGuarded !== false;
	if (
		typeof receipt.terminalEpoch !== "string" ||
		!receipt.terminalEpoch ||
		(expected.terminalEpoch !== undefined &&
			receipt.terminalEpoch !== expected.terminalEpoch) ||
		Boolean(text) !== expected.text ||
		Boolean(submit) !== expected.submit ||
		(atomic ? receipt.atomic !== true : receipt.atomic !== undefined) ||
		(guardRequested
			? receipt.draftGuarded !== undefined && receipt.draftGuarded !== atomic
			: receipt.draftGuarded !== undefined) ||
		(text &&
			submit &&
			(atomic
				? submit.recordId !== text.recordId
				: !isImmediateCanonicalDecimalSuccessor(
						submit.recordId,
						text.recordId,
					)))
	) {
		invalidReceipt("input_receipt_invalid");
	}
	return {
		terminalEpoch: receipt.terminalEpoch,
		...(text ? { text } : {}),
		...(submit ? { submit } : {}),
		...(atomic ? { atomic: true as const } : {}),
		...(guardRequested && receipt.draftGuarded !== undefined
			? { draftGuarded: atomic }
			: {}),
	};
}

export function parseHmuxInitialAgentPromptReceipt(
	value: unknown,
	expectedTerminalEpoch: string,
): HmuxInitialAgentPromptReceipt {
	if (!value || typeof value !== "object") {
		invalidReceipt("hmux_initial_agent_prompt_receipt_invalid");
	}
	const receipt = value as Record<string, unknown>;
	const runtimeRevision = receipt.initialAgentRuntimeRevision;
	if (
		receipt.terminalEpoch !== expectedTerminalEpoch ||
		!isCanonicalDecimalString(receipt.recordId) ||
		receipt.recordId === "0" ||
		!isCanonicalDecimalString(receipt.inputBaselineOutputSequence) ||
		(runtimeRevision !== undefined &&
			(!isCanonicalDecimalString(runtimeRevision) || runtimeRevision === "0"))
	) {
		invalidReceipt("hmux_initial_agent_prompt_receipt_invalid");
	}
	return {
		terminalEpoch: receipt.terminalEpoch,
		recordId: receipt.recordId,
		inputBaselineOutputSequence: receipt.inputBaselineOutputSequence,
		...(runtimeRevision === undefined
			? {}
			: { initialAgentRuntimeRevision: runtimeRevision }),
	};
}

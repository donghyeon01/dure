import { describe, expect, it } from "vitest";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import {
	deriveNextUp,
	NEXT_UP_REASON_BY_STATE,
	type NextUpFacts,
	nextUpEntries,
	nextUpTarget,
} from "@/lib/agents/nextUp";
import { ATTENTION_DISPLAY_STATES } from "@/lib/spaces/spacesStateFilter";

function facts(overrides: Partial<NextUpFacts>): NextUpFacts {
	return {
		agentIds: [],
		displayStates: {},
		episodes: {},
		acks: {},
		episodeKinds: {},
		episodeAt: {},
		waitingSince: {},
		...overrides,
	};
}

describe("deriveNextUp", () => {
	it("names every display state that needs a human, and only those", () => {
		expect(new Set(Object.keys(NEXT_UP_REASON_BY_STATE))).toEqual(
			ATTENTION_DISPLAY_STATES,
		);
	});

	it("lists Host attention oldest wait first, with unobserved starts ahead", () => {
		const nextUp = deriveNextUp(
			facts({
				agentIds: ["late", "working", "unseen", "early", "failed"],
				displayStates: {
					late: "blocked",
					working: "working",
					unseen: "input",
					early: "input",
					failed: "error",
				},
				waitingSince: { late: 3_000, early: 1_000, failed: 2_000 },
			}),
		);
		expect(nextUp.needsYou).toEqual([
			{ agentId: "unseen", reason: "input", state: "input" },
			{ agentId: "early", reason: "input", state: "input", sinceMs: 1_000 },
			{ agentId: "failed", reason: "error", state: "error", sinceMs: 2_000 },
			{ agentId: "late", reason: "approval", state: "blocked", sinceMs: 3_000 },
		]);
		expect(nextUp.finished).toEqual([]);
	});

	it("breaks equal waits by agent order", () => {
		const nextUp = deriveNextUp(
			facts({
				agentIds: ["b", "a"],
				displayStates: { a: "blocked", b: "blocked" },
			}),
		);
		expect(nextUp.needsYou.map((item) => item.agentId)).toEqual(["b", "a"]);
	});

	it("keeps an unread finished turn until work resumes", () => {
		const states: Record<string, AgentDisplayState> = {
			resting: "waiting",
			unobserved: "unknown",
			exited: "exited",
			read: "waiting",
			resumed: "working",
			approval: "waiting",
		};
		const nextUp = deriveNextUp(
			facts({
				agentIds: Object.keys(states),
				displayStates: states,
				episodes: {
					resting: 2,
					unobserved: 1,
					exited: 1,
					read: 2,
					resumed: 3,
					approval: 1,
				},
				acks: { resting: 1, read: 2 },
				episodeKinds: {
					resting: "done",
					unobserved: "done",
					exited: "done",
					read: "done",
					resumed: "done",
					approval: "approval",
				},
				episodeAt: { resting: 4_000, exited: 5_000 },
			}),
		);
		expect(nextUp.finished).toEqual([
			{ agentId: "unobserved", reason: "finished", state: "unknown" },
			{ agentId: "resting", reason: "finished", state: "waiting", sinceMs: 4_000 },
			{ agentId: "exited", reason: "finished", state: "exited", sinceMs: 5_000 },
		]);
	});

	it("skips agents the watcher has not resolved", () => {
		expect(deriveNextUp(facts({ agentIds: ["a"] }))).toEqual({
			needsYou: [],
			finished: [],
		});
	});
});

describe("nextUpTarget", () => {
	const nextUp = deriveNextUp(
		facts({
			agentIds: ["a", "b", "c"],
			displayStates: { a: "blocked", b: "blocked", c: "waiting" },
			episodes: { c: 1 },
			episodeKinds: { c: "done" },
		}),
	);
	const entries = nextUpEntries(nextUp);

	it("starts from the top when the focused agent is not waiting", () => {
		expect(nextUpTarget(entries, undefined)?.agentId).toBe("a");
		expect(nextUpTarget(entries, "elsewhere")?.agentId).toBe("a");
	});

	it("steps past the focused agent through needs-you and then finished", () => {
		expect(nextUpTarget(entries, "a")?.agentId).toBe("b");
		expect(nextUpTarget(entries, "b")?.agentId).toBe("c");
		expect(nextUpTarget(entries, "c")?.agentId).toBe("a");
	});

	it("has nowhere to go when nothing waits", () => {
		expect(nextUpTarget([], "a")).toBeUndefined();
	});
});

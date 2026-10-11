import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentAttention } from "./agentAttentionStore";

beforeEach(() => {
	useAgentAttention.setState(useAgentAttention.getInitialState(), true);
});

describe("attention store publication", () => {
	it("keeps repeated acknowledgements, input arms, and cleanup silent", () => {
		const store = useAgentAttention.getState();
		store.applyAttentionResolution({
			displayStates: { agent: "waiting" },
			bumps: [{ agentId: "agent", kind: "done", eventId: "turn-1" }],
			consumedArms: [],
		});
		store.ack("agent");
		store.armCompletion("session");
		const snapshot = useAgentAttention.getState();
		const listener = vi.fn();
		const unsubscribe = useAgentAttention.subscribe(listener);
		try {
			for (let poll = 0; poll < 20; poll += 1) {
				store.ack("agent");
				store.armCompletion("session");
				store.prune(new Set(["session"]), new Set(["agent"]));
			}
			expect(listener).not.toHaveBeenCalled();
			expect(useAgentAttention.getState()).toBe(snapshot);
		} finally {
			unsubscribe();
		}
	});

	it("publishes new attention, acknowledgements, and removed sessions", () => {
		const store = useAgentAttention.getState();
		const listener = vi.fn();
		const unsubscribe = useAgentAttention.subscribe(listener);
		try {
			store.armCompletion("session");
			expect(useAgentAttention.getState().armedCompletions).toEqual({
				session: true,
			});
			store.applyAttentionResolution({
				displayStates: { agent: "waiting" },
				bumps: [{ agentId: "agent", kind: "done", eventId: "turn-1" }],
				consumedArms: ["session"],
			});
			expect(useAgentAttention.getState().armedCompletions).toEqual({});
			expect(useAgentAttention.getState().episodes).toEqual({ agent: 1 });
			store.ack("agent");
			expect(useAgentAttention.getState().acks).toEqual({ agent: 1 });
			store.armCompletion("retired-session");
			store.prune(new Set(), new Set());
			expect(listener).toHaveBeenCalledTimes(5);
			expect(useAgentAttention.getState()).toMatchObject({
				episodes: {},
				acks: {},
				episodeKinds: {},
				episodeIds: {},
				displayStates: {},
				armedCompletions: {},
			});
		} finally {
			unsubscribe();
		}
	});

	it("records when episodes and waits were observed, and prunes them with the agent", () => {
		const store = useAgentAttention.getState();
		store.applyAttentionResolution({
			displayStates: { agent: "blocked" },
			bumps: [{ agentId: "agent", kind: "approval", observedAtMs: 1_000 }],
			consumedArms: [],
			waitingSince: { agent: 1_000 },
		});
		expect(useAgentAttention.getState()).toMatchObject({
			episodeAt: { agent: 1_000 },
			waitingSince: { agent: 1_000 },
		});
		const waits = useAgentAttention.getState().waitingSince;
		// A round that does not restate the waits leaves them as they were.
		store.applyAttentionResolution({
			displayStates: { agent: "waiting" },
			bumps: [{ agentId: "agent", kind: "done", observedAtMs: 5_000 }],
			consumedArms: [],
		});
		expect(useAgentAttention.getState().waitingSince).toBe(waits);
		expect(useAgentAttention.getState().episodeAt).toEqual({ agent: 5_000 });
		// An episode met after an unobserved stretch has no time, not the old one.
		store.applyAttentionResolution({
			displayStates: { agent: "waiting" },
			bumps: [{ agentId: "agent", kind: "done" }],
			consumedArms: [],
		});
		expect(useAgentAttention.getState().episodeAt).toEqual({});
		store.prune(new Set(), new Set());
		expect(useAgentAttention.getState()).toMatchObject({
			episodeAt: {},
			waitingSince: {},
		});
	});
});

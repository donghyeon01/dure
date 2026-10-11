// Which agent needs the person next — a presentation over the attention
// watcher's facts. Membership comes only from Host-owned display states and
// unread completion episodes; nothing here is persisted or answered, and a
// program's own status report never puts an agent in the list.
import {
	type AttentionEpisodeKind,
	isAgentUnread,
} from "@/lib/agents/agentAttentionStore";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import { ATTENTION_DISPLAY_STATES } from "@/lib/spaces/spacesStateFilter";

export type NextUpReason = "approval" | "input" | "error" | "finished";

export interface NextUpEntry {
	agentId: string;
	reason: NextUpReason;
	/** The agent's display state now, which its row's dot shows. */
	state: AgentDisplayState;
	/** When this window saw the reason begin. Absent when it began unobserved. */
	sinceMs?: number;
}

export interface NextUp {
	/** Agents a human is blocking, oldest wait first. */
	needsYou: NextUpEntry[];
	/** Finished turns nobody has looked at yet, oldest first. */
	finished: NextUpEntry[];
}

export interface NextUpFacts {
	/** Agents in store order; the tie-break between equal waits. */
	agentIds: readonly string[];
	displayStates: Readonly<Record<string, AgentDisplayState>>;
	episodes: Readonly<Record<string, number>>;
	acks: Readonly<Record<string, number>>;
	episodeKinds: Readonly<Record<string, AttentionEpisodeKind>>;
	episodeAt: Readonly<Record<string, number>>;
	waitingSince: Readonly<Record<string, number>>;
}

/** Every display state that needs a human, named for the person. Covering
 * ATTENTION_DISPLAY_STATES exactly is a tested contract. */
export const NEXT_UP_REASON_BY_STATE: Readonly<
	Partial<Record<AgentDisplayState, Exclude<NextUpReason, "finished">>>
> = { blocked: "approval", input: "input", error: "error" };

export function deriveNextUp(facts: NextUpFacts): NextUp {
	const needsYou: NextUpEntry[] = [];
	const finished: NextUpEntry[] = [];
	for (const agentId of facts.agentIds) {
		const state = facts.displayStates[agentId];
		if (state === undefined) continue;
		const reason = ATTENTION_DISPLAY_STATES.has(state)
			? NEXT_UP_REASON_BY_STATE[state]
			: undefined;
		if (reason) {
			needsYou.push(entry(agentId, reason, state, facts.waitingSince[agentId]));
		} else if (
			// Once work resumes, the result the turn produced is no longer the
			// latest. An agent that went unobserved or exited still has one.
			state !== "working" &&
			facts.episodeKinds[agentId] === "done" &&
			isAgentUnread(facts.episodes, facts.acks, agentId)
		) {
			finished.push(entry(agentId, "finished", state, facts.episodeAt[agentId]));
		}
	}
	const order = new Map(facts.agentIds.map((agentId, index) => [agentId, index]));
	const byWait = (left: NextUpEntry, right: NextUpEntry) =>
		// An unobserved start predates everything this window saw begin.
		(left.sinceMs ?? Number.NEGATIVE_INFINITY) -
			(right.sinceMs ?? Number.NEGATIVE_INFINITY) ||
		(order.get(left.agentId) ?? 0) - (order.get(right.agentId) ?? 0);
	return { needsYou: needsYou.sort(byWait), finished: finished.sort(byWait) };
}

export function nextUpEntries(nextUp: NextUp): NextUpEntry[] {
	return [...nextUp.needsYou, ...nextUp.finished];
}

/** The agent after the one in focus, in list order, wrapping around. A
 * focused agent outside the list starts from the top. */
export function nextUpTarget(
	entries: readonly NextUpEntry[],
	focusedAgentId: string | undefined,
): NextUpEntry | undefined {
	if (entries.length === 0) return undefined;
	const index = entries.findIndex((item) => item.agentId === focusedAgentId);
	return entries[(index + 1) % entries.length];
}

function entry(
	agentId: string,
	reason: NextUpReason,
	state: AgentDisplayState,
	sinceMs: number | undefined,
): NextUpEntry {
	return sinceMs === undefined
		? { agentId, reason, state }
		: { agentId, reason, state, sinceMs };
}

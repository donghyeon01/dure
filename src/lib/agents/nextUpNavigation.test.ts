import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getDockview: vi.fn(),
	mountedDockviewEntries: vi.fn(),
	navigateToPanel: vi.fn(),
	openAgentPanelOnDesktop: vi.fn(),
	hidden: {} as Record<string, { paneId: string; desktopId: string; at: number }>,
	storeState: {
		activeSpaceId: "space-a",
		agents: [] as { id: string; name: string }[],
		layouts: {} as Record<string, unknown>,
		spaces: [{ id: "space-a" }, { id: "space-b" }],
	},
}));

vi.mock("@/lib/workspace/dock", () => ({
	openAgentPanelOnDesktop: mocks.openAgentPanelOnDesktop,
}));
vi.mock("@/lib/workspace/dock/panelFocusHandoff", () => ({
	navigateToPanel: mocks.navigateToPanel,
}));
vi.mock("@/lib/workspace/dock/dockRegistry", () => ({
	getDockview: mocks.getDockview,
	mountedDockviewEntries: mocks.mountedDockviewEntries,
}));
vi.mock("@/lib/workspace/pane/hiddenPanesStore", () => ({
	useHiddenPanes: { getState: () => ({ hidden: mocks.hidden }) },
}));
vi.mock("@/store", () => ({
	useStore: { getState: () => mocks.storeState },
}));

import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { goToNextUp, revealAgent } from "@/lib/agents/nextUpNavigation";

function agentPanel(panelId: string, agentId: string) {
	const params = { agentRef: { agentId } };
	return {
		id: panelId,
		params,
		api: { component: "agent", getParameters: () => params },
	};
}

function dockview(...panels: ReturnType<typeof agentPanel>[]) {
	return { panels, activePanel: undefined as ReturnType<typeof agentPanel> | undefined };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.hidden = {};
	mocks.storeState.activeSpaceId = "space-a";
	mocks.storeState.agents = ["a", "b", "c"].map((id) => ({ id, name: id }));
	mocks.storeState.layouts = {};
	mocks.mountedDockviewEntries.mockReturnValue([]);
	mocks.getDockview.mockReturnValue(undefined);
	useAgentAttention.setState(useAgentAttention.getInitialState(), true);
});

describe("revealAgent", () => {
	it("prefers the agent's pane in the active Space", () => {
		mocks.mountedDockviewEntries.mockReturnValue([
			["space-b", dockview(agentPanel("pane-b", "a"))],
			["space-a", dockview(agentPanel("pane-a", "a"))],
		]);
		expect(revealAgent("a")).toBe(true);
		expect(mocks.navigateToPanel).toHaveBeenCalledWith("space-a", "pane-a");
	});

	it("switches to the Space that holds its only pane", () => {
		mocks.mountedDockviewEntries.mockReturnValue([
			["space-b", dockview(agentPanel("pane-b", "a"))],
		]);
		revealAgent("a");
		expect(mocks.navigateToPanel).toHaveBeenCalledWith("space-b", "pane-b");
	});

	it("restores a hidden pane through the agent opener, in its own Space", () => {
		mocks.hidden = { a: { paneId: "pane-b", desktopId: "space-b", at: 1 } };
		mocks.mountedDockviewEntries.mockReturnValue([
			["space-b", dockview(agentPanel("pane-b", "a"))],
		]);
		revealAgent("a");
		expect(mocks.navigateToPanel).not.toHaveBeenCalled();
		expect(mocks.openAgentPanelOnDesktop).toHaveBeenCalledWith(
			"space-b",
			mocks.storeState.agents[0],
		);
	});

	it("opens in the active Space when a hidden pane's Space is gone", () => {
		mocks.hidden = { a: { paneId: "pane-x", desktopId: "space-deleted", at: 1 } };
		revealAgent("a");
		expect(mocks.openAgentPanelOnDesktop).toHaveBeenCalledWith(
			"space-a",
			mocks.storeState.agents[0],
		);
	});

	it("opens an agent with no pane in the active Space", () => {
		revealAgent("b");
		expect(mocks.openAgentPanelOnDesktop).toHaveBeenCalledWith(
			"space-a",
			mocks.storeState.agents[1],
		);
	});

	it("does nothing for an agent that no longer exists", () => {
		expect(revealAgent("gone")).toBe(false);
		expect(mocks.navigateToPanel).not.toHaveBeenCalled();
		expect(mocks.openAgentPanelOnDesktop).not.toHaveBeenCalled();
	});
});

describe("goToNextUp", () => {
	beforeEach(() => {
		const space = dockview(
			agentPanel("pane-a", "a"),
			agentPanel("pane-b", "b"),
			agentPanel("pane-c", "c"),
		);
		mocks.mountedDockviewEntries.mockReturnValue([["space-a", space]]);
		mocks.getDockview.mockReturnValue(space);
	});

	it("leaves the key alone when nothing waits", () => {
		useAgentAttention.setState({
			displayStates: { a: "working", b: "waiting", c: "working" },
		});
		expect(goToNextUp()).toBe(false);
		expect(mocks.navigateToPanel).not.toHaveBeenCalled();
	});

	it("goes to the agent after the focused one", () => {
		useAgentAttention.setState({
			displayStates: { a: "blocked", b: "working", c: "input" },
		});
		const space = mocks.getDockview();
		space.activePanel = space.panels[0];
		expect(goToNextUp()).toBe(true);
		expect(mocks.navigateToPanel).toHaveBeenLastCalledWith("space-a", "pane-c");
		space.activePanel = space.panels[2];
		goToNextUp();
		expect(mocks.navigateToPanel).toHaveBeenLastCalledWith("space-a", "pane-a");
	});
});

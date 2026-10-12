import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareAgentProjectMove } from "@/lib/agents/agentProjectMove";

const f = vi.hoisted(() => ({
	checkpoint: vi.fn(),
	intent: vi.fn(),
	resolveRoute: vi.fn(),
	source: {} as Record<string, unknown>,
	project: vi.fn(),
	inspect: vi.fn(),
	transition: vi.fn(),
	preview: vi.fn(),
	apply: vi.fn(),
	projects: vi.fn(),
	agent: {
		id: "agent-1",
		pendingCredentialSwitch: undefined as object | undefined,
		pendingCmd: undefined as string | undefined,
	},
}));
const authority = {
	schemaVersion: 1,
	profileId: "owner",
	revision: "route-a",
	backend: { id: "backend-1", generation: "a" },
	target: { source: "local" },
};
const nextAuthority = {
	...authority,
	revision: "route-b",
	backend: { ...authority.backend, generation: "b" },
};
vi.mock("@/store", () => ({
	useStore: { getState: () => ({ agents: [f.agent] }) },
}));
vi.mock("@/lib/sessions/managed/managedAgentRehostConvergence", () => ({
	convergeManagedAgentRehost: async () => undefined,
}));
vi.mock("@/lib/agents/agentRuntimeStoreProjector", () => ({
	projectAgentRuntimeTransition: f.project,
}));
vi.mock("@/lib/agents/agentRuntimeTransitionAction", () => ({
	transitionAgentRuntime: f.transition,
	observeAgentRuntimeAction: async (
		_id: string,
		observe: (value: string) => void,
	) => {
		observe("conversation-1");
		return {
			client: {
				inspectExact: f.inspect,
				inspectTransitionIntent: f.intent,
				transition: f.transition,
			},
			checkpoint: f.checkpoint,
			observation: f.source,
		};
	},
}));
vi.mock("@/lib/ipc/dureAgentRuntime", () => ({
	createDureAgentRuntimeClient: () => ({ inspectExact: f.inspect }),
}));
vi.mock("@/lib/ipc/dureBackend", () => ({
	resolveSelectedDureBackendRouteAuthority: f.resolveRoute,
}));
vi.mock("@/lib/ipc/dureAgentProjectMove", () => ({
	createAgentProjectMoveClient: () => ({
		projects: f.projects,
		preview: f.preview,
		apply: f.apply,
	}),
}));
const plan = () => ({
	schemaVersion: 1 as const,
	operationId: "move-1",
	idempotencyKey: "request-1",
	source: { agentId: "agent-1", providerId: "codex" as const, revision: 7 },
	targetInteractionProfile: "native_cli" as const,
	providerConversationRef: "conversation-1",
	workspaceMove: {
		sourceAgent: { agentId: "agent-1" },
		sourceWorkspace: {
			workspaceId: "workspace-1",
			projectId: "old",
			rootPath: "/old",
		},
		targetProject: { projectId: "new" },
		targetWorkspace: {
			projectId: "new",
			workspaceId: "workspace-2",
			rootPath: "/new",
		},
	},
});
const committed = () => ({
	state: "stable",
	agentId: "agent-1",
	providerId: "codex",
	interactionProfile: "native_cli",
	routeAuthority: authority,
	providerConversationRef: "conversation-1",
	selectionRevision: 8,
	projectionContext: {
		workspaceMove: { operationId: "move-1" },
		workspace: { workspaceId: "workspace-2", projectId: "new", rootPath: "/new" },
	},
});

beforeEach(() => {
	vi.resetAllMocks();
	f.source = {
		state: "stable",
		selectionRevision: 7,
		backendProfileId: "owner",
		routeAuthority: authority,
	};
	f.resolveRoute.mockResolvedValue(authority);
	f.agent.pendingCmd = undefined;
	f.agent.pendingCredentialSwitch = undefined;
	f.projects.mockResolvedValue({
		projects: [{ id: "new", displayName: "New" }],
		complete: true,
	});
	f.preview.mockResolvedValue(plan());
	f.apply.mockResolvedValue(undefined);
	f.inspect.mockResolvedValue(committed());
	f.transition.mockResolvedValue(undefined);
});

describe("desktop project moves through the runtime owner", () => {
	it("previews without relabeling and projects only the inspected committed operation", async () => {
		const move = await prepareAgentProjectMove("agent-1");
		const reviewed = await move.preview("new");
		expect(f.project).not.toHaveBeenCalled();
		await move.apply(reviewed);
		expect(f.apply).toHaveBeenCalledWith(reviewed, authority);
		expect(f.project).toHaveBeenCalledWith("agent-1", committed());
	});
	it("converges a lost response without a second launch or preview", async () => {
		f.apply.mockRejectedValue(new Error("response lost"));
		const move = await prepareAgentProjectMove("agent-1");
		await move.apply(await move.preview("new"));
		expect(f.apply).toHaveBeenCalledOnce();
		expect(f.preview).toHaveBeenCalledOnce();
		expect(f.project).toHaveBeenCalledOnce();
	});
	it("keeps the exact plan when response loss has no matching committed evidence", async () => {
		f.apply.mockRejectedValue(new Error("response lost"));
		f.inspect.mockResolvedValue({ ...committed(), selectionRevision: 9 });
		const move = await prepareAgentProjectMove("agent-1");
		const reviewed = await move.preview("new");
		await expect(move.apply(reviewed)).rejects.toThrow("response lost");
		await expect(move.apply(reviewed)).rejects.toThrow("unconfirmed");
		expect(f.apply).toHaveBeenCalledOnce();
		expect(f.preview).toHaveBeenCalledOnce();
		expect(f.project).not.toHaveBeenCalled();
	});
	it("does not discard pending input added after preview", async () => {
		const move = await prepareAgentProjectMove("agent-1");
		const reviewed = await move.preview("new");
		f.agent.pendingCmd = "unsent input";
		await expect(move.apply(reviewed)).rejects.toThrow("pending_input");
		expect(f.agent.pendingCmd).toBe("unsent input");
		expect(f.apply).not.toHaveBeenCalled();
	});
	it("rejects a stale preview and a repair for another operation", async () => {
		f.preview.mockResolvedValue({
			...plan(),
			source: { ...plan().source, revision: 8 },
		});
		const move = await prepareAgentProjectMove("agent-1");
		await expect(move.preview("new")).rejects.toThrow("preview_stale");
		f.inspect.mockResolvedValue({
			state: "repair_required",
			routeAuthority: authority,
			operationId: "other-move",
		});
		await expect(move.repair(plan())).rejects.toThrow("unconfirmed");
		expect(f.transition).not.toHaveBeenCalled();
	});
	it("uses the exact source revision and backend for confirmed source-folder repair", async () => {
		const move = await prepareAgentProjectMove("agent-1");
		f.inspect
			.mockResolvedValueOnce({
				state: "repair_required",
				routeAuthority: authority,
				operationId: "move-1",
			})
			.mockResolvedValueOnce({
				...committed(),
				projectionContext: { workspace: { rootPath: "/old" } },
			});
		await move.repair(plan());
		expect(f.transition).toHaveBeenCalledWith({
			agentId: "agent-1",
			targetInteractionProfile: "native_cli",
			expectedSourceRevision: 7,
			expectedRouteAuthority: authority,
			expectedOperationId: "move-1",
			expectedConversationId: "conversation-1",
			beforeTransition: expect.any(Function),
		});
	});
});

it.each(["repair_required", "transitioning"])(
	"recovers the exact %s journal after remount",
	async (state) => {
		f.source = { ...f.source, state, stage: "admitted", operationId: "move-1" };
		f.intent.mockResolvedValue({ state, workspaceMovePlan: plan() });
		const move = await prepareAgentProjectMove("agent-1");
		expect(move.recoveredPlan).toEqual(plan());
		expect(move.recoveredStatus).toBe(state);
		expect(f.preview).not.toHaveBeenCalled();
		expect(f.projects).not.toHaveBeenCalled();
	},
);
it("observes generation B after a lost apply response on A without reissuing a move", async () => {
	f.resolveRoute.mockResolvedValue(nextAuthority);
	f.apply.mockRejectedValue(new Error("response lost"));
	f.inspect.mockResolvedValue({
		...committed(),
		routeAuthority: nextAuthority,
	});
	const move = await prepareAgentProjectMove("agent-1");
	const reviewed = await move.preview("new");
	await move.apply(reviewed);
	expect(await move.status(reviewed)).toBe("completed");
	expect(f.apply).toHaveBeenCalledOnce();
	expect(f.preview).toHaveBeenCalledOnce();
});
it.each(["repair_required", "transitioning", "stable"])(
	"keeps the same plan after restart with %s evidence",
	async (state) => {
		f.resolveRoute.mockResolvedValue(nextAuthority);
		f.apply.mockRejectedValue(new Error("response lost"));
		f.inspect.mockResolvedValue({
			...committed(),
			state,
			stage: "admitted",
			operationId: "move-1",
			selectionRevision: 7,
			routeAuthority: nextAuthority,
		});
		const move = await prepareAgentProjectMove("agent-1");
		const reviewed = await move.preview("new");
		await expect(move.apply(reviewed)).rejects.toThrow("response lost");
		expect(await move.status(reviewed)).toBe(
			state === "repair_required"
				? "repair_required"
				: state === "stable"
					? "not_submitted"
					: "unconfirmed",
		);
		expect(f.apply).toHaveBeenCalledOnce();
		expect(f.preview).toHaveBeenCalledOnce();
		if (state === "transitioning") {
			f.apply.mockImplementationOnce(async () => {
				f.inspect.mockResolvedValue({
					...committed(),
					routeAuthority: nextAuthority,
				});
			});
			await move.apply(reviewed);
			expect(f.apply).toHaveBeenLastCalledWith(reviewed, nextAuthority);
		}
	},
);
it("refuses a different owning backend even when operation IDs match", async () => {
	f.resolveRoute.mockResolvedValue({
		...nextAuthority,
		backend: { id: "other", generation: "b" },
	});
	f.inspect.mockResolvedValue({
		...committed(),
		routeAuthority: {
			...nextAuthority,
			backend: { id: "other", generation: "b" },
		},
	});
	const move = await prepareAgentProjectMove("agent-1");
	await expect(move.status(plan())).rejects.toThrow("backend_changed");
	expect(f.project).not.toHaveBeenCalled();
});
it("rechecks pending input after awaited repair inspection and in shared repair's dispatch hook", async () => {
	const move = await prepareAgentProjectMove("agent-1");
	f.inspect.mockImplementationOnce(async () => {
		f.agent.pendingCmd = "draft";
		return {
			state: "repair_required",
			operationId: "move-1",
			routeAuthority: authority,
		};
	});
	await expect(move.repair(plan())).rejects.toThrow("pending_input");
	expect(f.transition).not.toHaveBeenCalled();
	f.agent.pendingCmd = undefined;
	f.inspect.mockResolvedValue({
		state: "repair_required",
		operationId: "move-1",
		routeAuthority: authority,
	});
	f.transition.mockImplementationOnce(async (request) => {
		f.agent.pendingCmd = "draft";
		request.beforeTransition();
	});
	await expect(move.repair(plan())).rejects.toThrow("pending_input");
	expect(f.agent.pendingCmd).toBe("draft");
});
it("classifies a local checkpoint refusal as definitely not dispatched", async () => {
	const move = await prepareAgentProjectMove("agent-1");
	f.checkpoint.mockImplementationOnce(() => {
		throw new Error("route changed");
	});
	await expect(move.apply(plan())).rejects.toMatchObject({
		code: "client_project_move_preview_stale",
		submitted: false,
	});
	expect(f.apply).not.toHaveBeenCalled();
});

it("preserves a credential request that arrives while repair inspection awaits", async () => {
	const move = await prepareAgentProjectMove("agent-1");
	f.inspect.mockImplementationOnce(async () => {
		f.agent.pendingCredentialSwitch = { requestId: "queued" };
		return {
			state: "repair_required",
			operationId: "move-1",
			routeAuthority: authority,
		};
	});
	await expect(move.repair(plan())).rejects.toThrow("pending_input");
	expect(f.transition).not.toHaveBeenCalled();
	expect(f.agent.pendingCredentialSwitch).toEqual({ requestId: "queued" });
});

it("repairs a Chat move through the shared runtime owner without changing mode", async () => {
	const move = await prepareAgentProjectMove("agent-1");
	f.inspect.mockResolvedValue({
		state: "repair_required",
		routeAuthority: authority,
		operationId: "move-1",
	});
	await move.repair({
		...plan(),
		targetInteractionProfile: "structured_protocol",
	});
	expect(f.transition).toHaveBeenCalledWith(
		expect.objectContaining({
			targetInteractionProfile: "structured_protocol",
			expectedOperationId: "move-1",
			expectedSourceRevision: 7,
		}),
	);
});
it.each([
	{ providerId: "claude" },
	{ interactionProfile: "structured_protocol" },
	{ agentId: "another-agent" },
	{
		projectionContext: {
			...committed().projectionContext,
			workspace: {
				workspaceId: "workspace-2",
				projectId: "old",
				rootPath: "/new",
			},
		},
	},
	{
		projectionContext: {
			...committed().projectionContext,
			workspace: {
				workspaceId: "workspace-2",
				projectId: "new",
				rootPath: "/old",
			},
		},
	},
])(
	"does not project an unrelated stable destination: %j",
	async (replacement) => {
		const move = await prepareAgentProjectMove("agent-1");
		f.inspect.mockResolvedValue({ ...committed(), ...replacement });
		expect(await move.status(plan())).toBe("unconfirmed");
		expect(f.project).not.toHaveBeenCalled();
	},
);

it.each(["codex", "claude"] as const)(
	"projects a confirmed %s Chat move while retaining the source interaction",
	async (providerId) => {
		const reviewed = {
			...plan(),
			source: {
				...plan().source,
				providerId,
				interactionProfile: "structured_protocol" as const,
			},
			targetInteractionProfile: "structured_protocol" as const,
			sourceAuthority: {
				interactionProfile: "structured_protocol" as const,
				binding: { interactionSessionId: "interaction-1" },
			},
		};
		const result = {
			...committed(),
			providerId,
			interactionProfile: "structured_protocol",
			interactionSessionId: "interaction-1",
		};
		f.preview.mockResolvedValue(reviewed);
		f.inspect.mockResolvedValue(result);
		const move = await prepareAgentProjectMove("agent-1");
		await move.apply(await move.preview("new"));
		expect(f.project).toHaveBeenLastCalledWith("agent-1", result);
		f.project.mockClear();
		f.inspect.mockResolvedValue({
			...result,
			interactionSessionId: "different-interaction",
		});
		expect(await move.status(reviewed)).toBe("unconfirmed");
		expect(f.project).not.toHaveBeenCalled();
	},
);

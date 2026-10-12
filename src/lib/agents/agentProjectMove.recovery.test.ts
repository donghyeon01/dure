import { beforeEach, expect, it, vi } from "vitest";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import type { AppState } from "@/store";

const f = vi.hoisted(() => ({
	inspect: vi.fn(),
	intent: vi.fn(),
	transition: vi.fn(),
	project: vi.fn(),
	state: {} as Pick<AppState, "agents" | "projects" | "accounts" | "sshHosts">,
	readAuthority: {} as DureBackendRouteAuthorityV1,
}));
vi.mock("@/lib/ipc/dureBackend", async (original) => ({
	...(await original<object>()),
	resolveSelectedDureBackendRouteAuthority: async () => f.readAuthority,
}));
vi.mock("@/store", () => ({ useStore: { getState: () => f.state } }));
vi.mock("@/lib/ipc/dureAgentRuntime", async (original) => ({
	...(await original<object>()),
	createDureAgentRuntimeClient: () => ({
		inspect: f.inspect,
		inspectExact: f.inspect,
		inspectTransitionIntent: f.intent,
		transition: f.transition,
	}),
}));
vi.mock("@/lib/sessions/managed/managedAgentRehostConvergence", () => ({
	convergeManagedAgentRehost: async () => null,
}));
vi.mock("@/lib/agents/agentRuntimeStoreProjector", () => ({
	projectAgentRuntimeTransition: f.project,
}));

import { prepareAgentProjectMove } from "@/lib/agents/agentProjectMove";
import {
	agentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const route = testDureBackendRouteAuthority("backend-owner", "a");
const sourceContext = {
	identity: { kind: "registered" },
	agent: { agentId: "agent-1", providerId: "codex" },
	project: { projectId: "project-1", rootPath: "/repo" },
	workspace: {
		workspaceId: "workspace-1",
		projectId: "project-1",
		rootPath: "/old",
	},
};
const plan = {
	schemaVersion: 1,
	operationId: "move-1",
	idempotencyKey: "move-request",
	targetInteractionProfile: "native_cli",
	source: { agentId: "agent-1", providerId: "codex", revision: 7 },
	providerConversationRef: "conversation-1",
	workspaceMove: {
		sourceAgent: { agentId: "agent-1" },
		sourceWorkspace: sourceContext.workspace,
		targetProject: { projectId: "project-2" },
		targetWorkspace: {
			projectId: "project-2",
			workspaceId: "workspace-2",
			rootPath: "/new",
		},
	},
};
const required = {
	state: "repair_required",
	agentId: "agent-1",
	operationId: "move-1",
	journalRevision: 4,
	targetInteractionProfile: "native_cli",
	targetExecutionProfile: { kind: "provider_default" },
	backend: route.backend,
	backendProfileId: "local",
	routeAuthority: route,
	failureKind: "launch_failed",
	providerCode: "launch_failed",
	projectionContext: sourceContext,
};
const selection = { model: null, effort: null, permissionMode: "default" };
const intent = {
	...required,
	sourceSelectionRevision: 7,
	sourceInteractionProfile: "native_cli",
	sourceExecutionProfile: { kind: "provider_default" },
	sourceLaunchSelection: selection,
	targetLaunchSelection: selection,
	workspaceMovePlan: plan,
};
const stable = (folder = "/old", authority = route) => ({
	state: "stable",
	agentId: "agent-1",
	providerId: "codex",
	providerConversationRef: "conversation-1",
	selectionRevision: 8,
	interactionProfile: "native_cli",
	executionProfile: { kind: "provider_default" },
	launchSelection: selection,
	sessionId: "session-2",
	workspaceId: folder === "/old" ? "workspace-1" : "workspace-2",
	launchIdempotencyKey: "successor-key",
	transitionLineage:
		folder === "/old"
			? { operationId: "repair-1", predecessorOperationId: "move-1" }
			: { operationId: "move-1" },
	stopFence: stopFenceFixture(),
	backend: authority.backend,
	backendProfileId: "local",
	routeAuthority: authority,
	projectionContext:
		folder === "/old"
			? sourceContext
			: {
					...sourceContext,
					project: { projectId: "project-2", rootPath: "/new" },
					workspace: plan.workspaceMove.targetWorkspace,
					workspaceMove: { operationId: "move-1" },
				},
});
beforeEach(() => {
	vi.resetAllMocks();
	f.readAuthority = route;
	f.state = {
		agents: [
			agentFixture({
				conversationId: "conversation-1",
				worktreePath: "/old",
				runtimeBinding: managedBindingFixture(),
			}),
		],
		projects: [
			{
				id: "project-1",
				name: "Project",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
		accounts: [],
		sshHosts: [],
	};
	f.inspect.mockResolvedValue(required);
	f.intent.mockResolvedValue(intent);
});
it("control: reconciles an immediately observable lost repair response through the real shared owner", async () => {
	const move = await prepareAgentProjectMove("agent-1");
	f.transition.mockImplementationOnce(async () => {
		f.inspect.mockResolvedValue(stable());
		throw new Error("lost response");
	});
	await move.repair(move.recoveredPlan!);
	expect(f.transition).toHaveBeenCalledTimes(1);
	expect(f.project).toHaveBeenCalledTimes(1);
});
it.each(["pendingCmd", "pendingCredentialSwitch"] as const)(
	"control: refuses %s added during the shared intent inspection",
	async (field) => {
		const move = await prepareAgentProjectMove("agent-1");
		f.intent.mockImplementationOnce(async () => {
			Object.assign(f.state.agents[0], {
				[field]: field === "pendingCmd" ? "draft" : { requestId: "new" },
			});
			return intent;
		});
		await expect(move.repair(move.recoveredPlan!)).rejects.toThrow(
			"pending_input",
		);
		expect(f.transition).not.toHaveBeenCalled();
		expect(f.state.agents[0][field]).toBeDefined();
	},
);
it("rejects destination completion when a concurrent client retries the original move", async () => {
	const move = await prepareAgentProjectMove("agent-1");
	f.transition.mockImplementationOnce(async () => {
		f.inspect.mockResolvedValue(stable("/new"));
		throw new Error("agent_runtime_transition_conflict");
	});
	await expect(move.repair(move.recoveredPlan!)).rejects.toThrow();
	expect(f.project).not.toHaveBeenCalled();
});
it("recognizes durable source repair after the response and immediate reconciliation are lost", async () => {
	const move = await prepareAgentProjectMove("agent-1");
	f.transition.mockImplementationOnce(async () => {
		f.inspect.mockRejectedValue(new Error("backend unavailable"));
		throw new Error("lost repair response");
	});
	await expect(move.repair(move.recoveredPlan!)).rejects.toThrow(
		"lost repair response",
	);
	f.readAuthority = {
		...route,
		backend: { ...route.backend, generation: "b" },
	};
	f.inspect.mockResolvedValue(stable("/old", f.readAuthority));
	expect(await move.status(move.recoveredPlan!)).toBe("completed");
});

it.each([
	undefined,
	{ operationId: "unrelated", predecessorOperationId: "other-move" },
	{ operationId: "move-1" },
])(
	"does not identify a source folder as repair without its exact lineage: %j",
	async (transitionLineage) => {
		const move = await prepareAgentProjectMove("agent-1");
		f.inspect.mockResolvedValue({ ...stable(), transitionLineage });
		expect(await move.status(move.recoveredPlan!)).toBe("unconfirmed");
		expect(f.project).not.toHaveBeenCalled();
	},
);
it("transmits the exact repair operation and preserves fresh projection evidence", async () => {
	const move = await prepareAgentProjectMove("agent-1");
	const result = {
		...stable(),
		projectionContext: {
			...sourceContext,
			agent: { ...sourceContext.agent, workspaceId: "workspace-1" },
		},
	};
	f.transition.mockImplementationOnce(async () => {
		f.inspect.mockResolvedValue(result);
		return result;
	});
	await move.repair(move.recoveredPlan!);
	expect(f.transition.mock.calls[0][0].expectedOperationId).toBe("move-1");
	expect(f.project.mock.calls[0][1].projectionContext).toBe(
		result.projectionContext,
	);
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuntimeProjectionContext } from "@/test/dureAgentRuntimeFixtures";

const mocks = vi.hoisted(() => ({
	inspect: vi.fn(),
	inspectTransitionIntent: vi.fn(),
	transition: vi.fn(),
	repair: vi.fn(),
	project: vi.fn(),
}));

vi.mock("@/lib/ipc/dureAgentRuntime", async (original) => ({
	...(await original<object>()),
	createDureAgentRuntimeClient: () => ({
		...mocks,
		inspectExact: mocks.inspect,
	}),
}));
vi.mock("@/lib/ipc/dureBackend", async (original) => ({
	...(await original<object>()),
	resolveSelectedDureBackendRouteAuthority: async () => routeAuthority,
}));
vi.mock("@/lib/sessions/managed/managedAgentRehostConvergence", () => ({
	convergeManagedAgentRehost: async () => null,
}));
vi.mock("@/lib/agents/agentRuntimeStoreProjector", () => ({
	projectAgentRuntimeTransition: mocks.project,
}));

import { useStore } from "@/store";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import { prepareAgentProjectMove } from "./agentProjectMove";
import { transitionAgentRuntime } from "./agentRuntimeTransitionAction";

const routeAuthority = testDureBackendRouteAuthority("local", "backend-1");
const admitted = {
	state: "transitioning",
	stage: "admitted",
	agentId: "agent-1",
	operationId: "transition-1",
	journalRevision: 1,
	targetInteractionProfile: "structured_protocol",
	targetExecutionProfile: { kind: "provider_default" },
	backend: { id: "local", generation: "backend-1" },
	backendProfileId: "local",
	routeAuthority,
} as const;
const intent = {
	...admitted,
	sourceSelectionRevision: 2,
	sourceInteractionProfile: "native_cli",
	sourceExecutionProfile: { kind: "provider_default" },
	sourceLaunchSelection: {
		model: null,
		effort: null,
		permissionMode: "default",
	},
	targetLaunchSelection: {
		model: null,
		effort: null,
		permissionMode: "default",
	},
};
const result = {
	agentId: admitted.agentId,
	interactionProfile: admitted.targetInteractionProfile,
	executionProfile: admitted.targetExecutionProfile,
	selectionRevision: 3,
	backend: admitted.backend,
	backendProfileId: admitted.backendProfileId,
	routeAuthority,
};

beforeEach(() => {
	vi.resetAllMocks();
	useStore.setState({
		agents: [agentFixture({ runtimeBinding: managedBindingFixture() })],
		projects: [
			{
				id: "project-1",
				name: "Project",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
	});
	mocks.inspect.mockResolvedValue(admitted);
	mocks.inspectTransitionIntent.mockResolvedValue(intent);
	mocks.transition.mockResolvedValue(result);
	mocks.repair.mockResolvedValue(result);
});

describe("admitted runtime actions", () => {
	it("submits the same transition intent as the CLI without selecting repair", async () => {
		await expect(
			transitionAgentRuntime({
				agentId: "agent-1",
				targetInteractionProfile: "structured_protocol",
			}),
		).resolves.toEqual(result);
		expect(mocks.transition).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-1",
				targetInteractionProfile: "structured_protocol",
				routeAuthority,
			}),
		);
		expect(mocks.repair).not.toHaveBeenCalled();
	});

	it("lets the backend decide a different target instead of rejecting it locally", async () => {
		const conflict = new Error("agent_runtime_transition_conflict");
		mocks.transition.mockRejectedValue(conflict);
		await expect(
			transitionAgentRuntime({
				agentId: "agent-1",
				targetInteractionProfile: "native_cli",
			}),
		).rejects.toBe(conflict);
		expect(mocks.transition).toHaveBeenCalledTimes(1);
		expect(mocks.repair).not.toHaveBeenCalled();
	});

	it("normalizes launch edits from the journal source and submits them once", async () => {
		await transitionAgentRuntime({
			agentId: "agent-1",
			targetInteractionProfile: "structured_protocol",
			targetLaunchSelectionUpdate: (source) => ({
				...source,
				model: "gpt-5.6-sol",
			}),
		});
		expect(mocks.transition).toHaveBeenCalledWith(
			expect.objectContaining({
				targetLaunchSelection: {
					model: "gpt-5.6-sol",
					effort: null,
					permissionMode: "default",
				},
			}),
		);
		expect(mocks.repair).not.toHaveBeenCalled();
	});
});

describe("queued runtime dispatch authorization", () => {
	it("honors cancellation after asynchronous source preparation and before dispatch", async () => {
		let cancelled = false;
		mocks.inspectTransitionIntent.mockImplementationOnce(async () => {
			cancelled = true;
			return intent;
		});
		await expect(
			transitionAgentRuntime({
				agentId: "agent-1",
				targetInteractionProfile: "preserve",
				expectedSourceRevision: 2,
				beforeTransition: () => {
					if (cancelled) throw new Error("request_cancelled");
				},
			}),
		).rejects.toThrow("request_cancelled");
		expect(mocks.transition).not.toHaveBeenCalled();
	});
});

describe("project move uses shared repair reconciliation", () => {
	const movePlan = {
		schemaVersion: 1,
		operationId: "transition-1",
		idempotencyKey: "move-request",
		targetInteractionProfile: "native_cli",
		source: { agentId: "agent-1", providerId: "codex", revision: 2 },
		providerConversationRef: "conversation-1",
		workspaceMove: {
			sourceAgent: { agentId: "agent-1" },
			sourceWorkspace: {
				workspaceId: "workspace-1",
				projectId: "project-1",
				rootPath: "/repo/.worktrees/agent-1",
			},
			targetProject: { projectId: "project-2" },
			targetWorkspace: {
				workspaceId: "move-workspace",
				rootPath: "/destination",
			},
		},
	};
	const required = {
		...admitted,
		state: "repair_required",
		targetInteractionProfile: "native_cli",
		failureKind: "launch_failed",
		providerCode: "launch_failed",
	};
	it("reconciles a lost repair response to the observed original-folder successor without another launch", async () => {
		useStore.setState({
			agents: [
				agentFixture({
					conversationId: "conversation-1",
					runtimeBinding: managedBindingFixture(),
				}),
			],
		});
		mocks.inspect.mockResolvedValue(required);
		mocks.inspectTransitionIntent.mockResolvedValue({
			...intent,
			...required,
			workspaceMovePlan: movePlan,
		});
		const move = await prepareAgentProjectMove("agent-1");
		const restored = {
			...result,
			state: "stable",
			providerId: "codex",
			providerConversationRef: "conversation-1",
			interactionProfile: "native_cli",
			launchSelection: intent.sourceLaunchSelection,
			sessionId: "session-2",
			workspaceId: "workspace-1",
			launchIdempotencyKey: "repair-key",
			transitionLineage: {
				operationId: "repair-1",
				predecessorOperationId: movePlan.operationId,
			},
			projectionContext: {
				...agentRuntimeProjectionContext("agent-1", "codex"),
				workspace: movePlan.workspaceMove.sourceWorkspace,
			},
			stopFence: {
				runnerPrincipal: "principal",
				runnerInstance: "runner",
				channelEpoch: "2",
				hostInstanceId: "host",
				terminalEpoch: "2",
			},
		};
		mocks.transition.mockImplementationOnce(async () => {
			mocks.inspect.mockResolvedValue(restored);
			throw new Error("repair response lost");
		});
		await move.repair(move.recoveredPlan!);
		expect(mocks.transition).toHaveBeenCalledOnce();
		expect(mocks.project).toHaveBeenCalledWith(
			"agent-1",
			expect.objectContaining(restored),
		);
	});
	it("refuses a different repair operation without submitting a replacement", async () => {
		await expect(
			transitionAgentRuntime({
				agentId: "agent-1",
				targetInteractionProfile: "native_cli",
				expectedOperationId: "other-operation",
			}),
		).rejects.toThrow("conflict");
		expect(mocks.transition).not.toHaveBeenCalled();
	});
});

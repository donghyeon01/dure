import { describe, expect, it, vi } from "vitest";
import { createAgentProjectMoveClient } from "@/lib/ipc/dureAgentProjectMove";
import { createDureAgentRuntimeClient } from "@/lib/ipc/dureAgentRuntime";
import { agentRuntimeBackendEnvelope, agentRuntimeProjectionContext } from "@/test/dureAgentRuntimeFixtures";

function fixture() {
	const envelope = agentRuntimeBackendEnvelope();
	const plan = {
		schemaVersion: 1,
		operationId: "move-1",
		idempotencyKey: "request-1",
		source: { agentId: "agent-1", providerId: "codex", revision: 7 },
		targetInteractionProfile: "native_cli",
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
	};
	const invokeCommand = vi.fn().mockResolvedValue({
		...envelope,
		result: { schemaVersion: 1, plan, requiresRestartConfirmation: true },
	});
	const client = createAgentProjectMoveClient({
		profileId: envelope.routeAuthority.profileId,
		invokeCommand,
	});
	return { envelope, plan, invokeCommand, client };
}

describe("project move transport", () => {
	it("carries the same reviewed plan and exact backend route with explicit restart confirmation", async () => {
		const f = fixture();
		const plan = await f.client.preview(
			"agent-1",
			"new",
			f.envelope.routeAuthority,
		);
		expect(f.invokeCommand.mock.calls[0][1]).toMatchObject({
			route: { kind: "exact", authority: f.envelope.routeAuthority },
			operation: "agent_runtime.project_move.preview.v1",
		});
		f.invokeCommand.mockResolvedValue({
			...f.envelope,
			result: {
				schemaVersion: 1,
				receipt: {
					agentId: "agent-1",
					providerId: "codex",
					selectionRevision: 8,
					providerConversationRef: "conversation-1",
					authority: { interactionProfile: "native_cli", authority: { runtimeWorkspaceId: "workspace-2" } },
				},
			},
		});
		await f.client.apply(plan, f.envelope.routeAuthority);
		expect(f.invokeCommand.mock.calls[1][1]).toMatchObject({
			route: { kind: "exact", authority: f.envelope.routeAuthority },
			operation: "agent_runtime.project_move.apply.v1",
			body: { schemaVersion: 1, plan, confirmRestart: true },
		});
	});
	it("refuses a destructive preview before apply", async () => {
		const f = fixture();
		f.invokeCommand.mockResolvedValue({
			...f.envelope,
			result: {
				schemaVersion: 1,
				plan: { ...f.plan, sourceStopPolicy: "discard" },
				requiresRestartConfirmation: true,
			},
		});
		await expect(
			f.client.preview("agent-1", "new", f.envelope.routeAuthority),
		).rejects.toThrow("response_invalid");
		expect(f.invokeCommand).toHaveBeenCalledOnce();
	});
});

it("uses the shared structured move receipt and decodes its committed project proof", async () => {
	const f = fixture();
	const binding = f.envelope.result.receipt.authority.binding;
	const reviewed = {
		...f.plan,
		targetInteractionProfile: "structured_protocol",
		source: {
			...f.plan.source,
			providerId: "claude",
			interactionProfile: "structured_protocol",
		},
		sourceAuthority: { interactionProfile: "structured_protocol", binding },
	};
	f.invokeCommand.mockResolvedValue({
		...f.envelope,
		result: {
			schemaVersion: 1,
			plan: reviewed,
			requiresRestartConfirmation: true,
		},
	});
	const plan = await f.client.preview(
		"agent-1",
		"new",
		f.envelope.routeAuthority,
	);
	const receipt = {
		...f.envelope.result.receipt,
		selectionRevision: 8,
		transitionLineage: { operationId: "move-1" },
	};
	f.invokeCommand.mockResolvedValue({
		...f.envelope,
		result: {
			schemaVersion: 1,
			receipt,
			workspace: reviewed.workspaceMove.targetWorkspace,
		},
	});
	await f.client.apply(plan, f.envelope.routeAuthority);
	const context = agentRuntimeProjectionContext();
	const projectionContext = {
		...context,
		agent: { ...context.agent, workspaceId: "workspace-2" },
		project: { projectId: "new", rootPath: "/new" },
		workspace: reviewed.workspaceMove.targetWorkspace,
		workspaceMove: {
			operationId: "move-1",
			committedSelectionRevision: 8,
			sourceRootPath: "/old",
			sourceStructuredBinding: binding,
		},
	};
	f.invokeCommand.mockResolvedValue({
		...f.envelope,
		result: { schemaVersion: 1, state: "stable", receipt, projectionContext },
	});
	const runtime = createDureAgentRuntimeClient({
		profileId: f.envelope.routeAuthority.profileId,
		invokeCommand: f.invokeCommand,
	});
	await expect(
		runtime.inspectExact("agent-1", f.envelope.routeAuthority),
	).resolves.toMatchObject({
		state: "stable",
		interactionProfile: "structured_protocol",
		interactionSessionId: binding.interactionSessionId,
		projectionContext: {
			workspace: reviewed.workspaceMove.targetWorkspace,
			workspaceMove: {
				operationId: "move-1",
				sourceStructuredBinding: binding,
			},
		},
	});
	f.invokeCommand.mockResolvedValue({
		...f.envelope,
		result: {
			schemaVersion: 1,
			state: "stable",
			receipt,
			projectionContext: {
				...projectionContext,
				workspaceMove: {
					...projectionContext.workspaceMove,
					sourceStructuredBinding: { ...binding, providerId: "codex" },
				},
			},
		},
	});
	await expect(
		runtime.inspectExact("agent-1", f.envelope.routeAuthority),
	).rejects.toThrow();
});

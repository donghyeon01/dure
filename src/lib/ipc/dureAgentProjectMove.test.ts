import { describe, expect, it, vi } from "vitest";
import { createAgentProjectMoveClient } from "@/lib/ipc/dureAgentProjectMove";
import { agentRuntimeBackendEnvelope } from "@/test/dureAgentRuntimeFixtures";

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
					authority: { authority: { runtimeWorkspaceId: "workspace-2" } },
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

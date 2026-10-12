import {
	createDureBackendRequester,
	type DureBackendInvoke,
} from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { readDureProjects } from "@/lib/ipc/dureProjects";
import {
	type AgentProjectMovePlan,
	isAgentProjectMovePlan,
	isAgentProjectMoveReceipt,
} from "../../../cli/lib/contracts/agent-project-move.mjs";

export type { AgentProjectMovePlan };

export function createAgentProjectMoveClient(options: {
	profileId: string;
	invokeCommand?: DureBackendInvoke;
}) {
	const invalid = (): never => {
		throw new Error("client_project_move_response_invalid");
	};
	const request = createDureBackendRequester({
		...options,
		invalidResponseCode: "client_project_move_response_invalid",
		invalidResponseMessage: "agents.projectMove.failed",
		backendChangedCode: "client_project_move_backend_changed",
		backendChangedMessage: "ipc.dureBackend.generationChanged",
		requestFailedCode: "client_project_move_failed",
		requestFailedMessage: "agents.projectMove.failed",
	});
	const exact = (authority: DureBackendRouteAuthorityV1) => ({
		kind: "exact" as const,
		authority,
	});
	return {
		projects: (authority: DureBackendRouteAuthorityV1) =>
			readDureProjects(request, authority, invalid),
		async preview(
			agentId: string,
			projectId: string,
			authority: DureBackendRouteAuthorityV1,
		): Promise<AgentProjectMovePlan> {
			const { result } = await request(
				"agent_runtime.project_move.preview.v1",
				{
					schemaVersion: 1,
					agentId,
					projectId,
					idempotencyKey: crypto.randomUUID(),
				},
				exact(authority),
			);
			if (
				result.schemaVersion !== 1 ||
				result.requiresRestartConfirmation !== true ||
				!isAgentProjectMovePlan(result.plan, agentId, projectId)
			)
				invalid();
			return result.plan as AgentProjectMovePlan;
		},
		async apply(
			plan: AgentProjectMovePlan,
			authority: DureBackendRouteAuthorityV1,
		) {
			if (
				!isAgentProjectMovePlan(
					plan,
					plan.source.agentId,
					plan.workspaceMove.targetProject.projectId,
				)
			)
				invalid();
			const { result } = await request(
				"agent_runtime.project_move.apply.v1",
				{
					schemaVersion: 1,
					plan,
					confirmRestart: true,
				},
				exact(authority),
			);
			if (!isAgentProjectMoveReceipt(result, plan)) invalid();
		},
	};
}

// Isolated presentation boundary: no IPC, accounts, runtime processes or user data.
const plan = {
  schemaVersion: 1, operationId: "fixture-move", idempotencyKey: "fixture-request",
  source: { agentId: "fixture-agent", providerId: "codex", revision: 7 },
  providerConversationRef: "fixture-conversation", targetInteractionProfile: "native_cli",
  workspaceMove: { sourceAgent: { agentId: "fixture-agent" },
    sourceWorkspace: { rootPath: "/projects/original" }, targetProject: { projectId: "destination" },
    targetWorkspace: { workspaceId: "fixture-workspace", rootPath: "/projects/destination" } },
};
let attempted = false;
export const evidence = { previews: 0, applies: 0, inspections: 0, repairs: 0 };
export async function prepareAgentProjectMove() {
  return {
    projects: [{ id: "destination", displayName: "Destination project" }], complete: true,
    recoveredPlan: attempted ? plan : undefined,
    recoveredStatus: attempted ? "repair_required" : undefined,
    preview: async () => { evidence.previews++; return plan; },
    apply: async (reviewed: unknown) => {
      if (reviewed !== plan) throw new Error("fixture plan was replaced");
      evidence.applies++; attempted = true;
      throw new Error("fixture response lost");
    },
    status: async () => { evidence.inspections++; return "repair_required"; },
    repair: async () => { evidence.repairs++; },
  };
}

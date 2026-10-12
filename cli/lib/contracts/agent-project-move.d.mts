export interface AgentProjectMovePlan {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly source: { readonly agentId: string; readonly providerId: "codex" | "claude"; readonly revision: number; readonly interactionProfile?: "native_cli" | "structured_protocol" };
  readonly providerConversationRef: string;
  readonly targetInteractionProfile: "native_cli" | "structured_protocol";
  readonly sourceAuthority?: {
    readonly interactionProfile: "native_cli" | "structured_protocol";
    readonly binding?: { readonly interactionSessionId: string };
  };
  readonly workspaceMove: {
    readonly sourceAgent: { readonly agentId: string };
    readonly sourceWorkspace: { readonly workspaceId: string; readonly projectId: string; readonly rootPath: string };
    readonly targetProject: { readonly projectId: string };
    readonly targetWorkspace: { readonly projectId: string; readonly workspaceId: string; readonly rootPath: string };
    readonly sourceCheckout?: unknown;
  };
  readonly [key: string]: unknown;
}
export function isAgentProjectMovePlan(value: unknown, agentId: string, projectId: string): value is AgentProjectMovePlan;
export function isAgentProjectMoveReceipt(result: unknown, plan: AgentProjectMovePlan): boolean;

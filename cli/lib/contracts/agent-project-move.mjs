import { isDureDomainIdV1 } from "./protocol-identity.mjs";

/** The backend owns admission. Desktop and CLI carry the same reviewed plan,
 * including an immutable idle observation when the source is live. */
export function isAgentProjectMovePlan(plan, agentId, projectId) {
  const move = plan?.workspaceMove;
  const policy = plan?.sourceStopPolicy;
  const observed = policy?.preserve_observed;
  const safeStop = policy === undefined || policy === "preserve" ||
    (observed && Number.isSafeInteger(observed.runtimeRevision) && observed.runtimeRevision > 0 &&
      Number.isSafeInteger(observed.observedThroughOutputSeq) && observed.observedThroughOutputSeq >= 0);
  return Boolean(safeStop && plan?.schemaVersion === 1 && plan.source?.agentId === agentId &&
    Number.isSafeInteger(plan.source.revision) && plan.source.revision > 0 &&
    isDureDomainIdV1(plan.operationId) && isDureDomainIdV1(plan.idempotencyKey) &&
    ["codex", "claude"].includes(plan.source.providerId) && plan.targetInteractionProfile === "native_cli" &&
    typeof plan.providerConversationRef === "string" && plan.providerConversationRef.length > 0 &&
    move?.sourceAgent?.agentId === agentId &&
    isDureDomainIdV1(move.sourceWorkspace?.workspaceId) && isDureDomainIdV1(move.sourceWorkspace?.projectId) &&
    typeof move.sourceWorkspace?.rootPath === "string" && move.sourceWorkspace.rootPath.length > 0 &&
    move.targetProject?.projectId === projectId &&
    move.targetWorkspace?.projectId === projectId && isDureDomainIdV1(move.targetWorkspace.workspaceId) &&
    typeof move.targetWorkspace.rootPath === "string" && move.targetWorkspace.rootPath.length > 0);
}

export function isAgentProjectMoveReceipt(result, plan) {
  const receipt = result?.receipt;
  return result?.schemaVersion === 1 && receipt?.agentId === plan.source.agentId &&
    receipt.providerId === plan.source.providerId && receipt.selectionRevision === plan.source.revision + 1 &&
    receipt.providerConversationRef === plan.providerConversationRef &&
    receipt.authority?.authority?.runtimeWorkspaceId === plan.workspaceMove.targetWorkspace.workspaceId;
}

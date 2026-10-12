import { isDureDomainIdV1 } from "./protocol-identity.mjs";

/** The backend owns admission. Desktop and CLI carry the same reviewed plan,
 * including an immutable idle observation when the source is live. */
export function isAgentProjectMovePlan(plan, agentId, projectId) {
  const move = plan?.workspaceMove;
  const policy = plan?.sourceStopPolicy;
  const observed = policy?.preserve_observed;
  const profile = plan?.targetInteractionProfile;
  const sourceBinding = plan?.sourceAuthority?.binding;
  const sameMode = profile === "native_cli"
    ? plan.source?.interactionProfile === undefined || plan.source.interactionProfile === profile
    : profile === "structured_protocol" && plan.source?.interactionProfile === profile &&
      plan.sourceAuthority?.interactionProfile === profile &&
      isDureDomainIdV1(sourceBinding?.interactionSessionId) && sourceBinding.agentId === agentId &&
      sourceBinding.providerId === plan.source.providerId && sourceBinding.providerConversationRef === plan.providerConversationRef;
  const safeStop = policy === undefined || policy === "preserve" ||
    (observed && Number.isSafeInteger(observed.runtimeRevision) && observed.runtimeRevision > 0 &&
      Number.isSafeInteger(observed.observedThroughOutputSeq) && observed.observedThroughOutputSeq >= 0);
  return Boolean(safeStop && plan?.schemaVersion === 1 && plan.source?.agentId === agentId &&
    Number.isSafeInteger(plan.source.revision) && plan.source.revision > 0 &&
    isDureDomainIdV1(plan.operationId) && isDureDomainIdV1(plan.idempotencyKey) &&
    ["codex", "claude"].includes(plan.source.providerId) && sameMode &&
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
  if (!(result?.schemaVersion === 1 && receipt?.agentId === plan.source.agentId &&
    receipt.providerId === plan.source.providerId && receipt.selectionRevision === plan.source.revision + 1 &&
    receipt.providerConversationRef === plan.providerConversationRef &&
    receipt.authority?.interactionProfile === plan.targetInteractionProfile)) return false;
  if (plan.targetInteractionProfile === "native_cli") {
    return receipt.authority.authority?.runtimeWorkspaceId === plan.workspaceMove.targetWorkspace.workspaceId;
  }
  // Structured bindings have no Hmux workspace ID. Require the committed
  // workspace and exact journal lineage, rather than trusting the requested cwd.
  const workspace = result.workspace;
  const target = plan.workspaceMove.targetWorkspace;
  const sourceSession = plan.sourceAuthority?.binding?.interactionSessionId;
  const binding = receipt.authority.binding;
  return plan.targetInteractionProfile === "structured_protocol" &&
    isDureDomainIdV1(sourceSession) && binding?.interactionSessionId === sourceSession &&
    binding.agentId === plan.source.agentId && binding.providerId === plan.source.providerId &&
    binding.providerConversationRef === plan.providerConversationRef &&
    receipt.transitionLineage?.operationId === plan.operationId &&
    workspace?.workspaceId === target.workspaceId && workspace.projectId === target.projectId &&
    workspace.rootPath === target.rootPath;
}

/** Shared semantic recovery guidance. Native ownership remains backend-owned. */
export function browserProfileRecoveryAction(code, state = undefined) {
  if (code === "browser_profile_exit_unconfirmed") {
    if (state === "restart_required") return "restart";
    if (state === "live") return "wait";
    if (state === "unconfirmed") return "inspect";
    return "recover";
  }
  if (code === "browser_profile_recovery_restart_required") return "restart";
  if (code === "browser_profile_owner_live" || code === "browser_profile_recovery_in_progress") return "wait";
  if (code === "browser_profile_recovery_unconfirmed") return "inspect";
  return undefined;
}

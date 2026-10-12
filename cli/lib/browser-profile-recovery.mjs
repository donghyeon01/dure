import { browserProfileRecoveryAction } from "./contracts/browser-profile-recovery.mjs";

export function profileRecoveryFailure(error, recovery) {
  const action = browserProfileRecoveryAction(error?.remoteCode ?? error?.code, recovery?.state);
  const nextAction = {
    recover: "Inspect with dure browser tab profile status --profile ID, then run dure browser tab profile recover --profile ID --idempotency-key KEY on the same backend. If status is restart_required, recovery requires restarting the computer running that backend; restarting only Dure is insufficient. Browser create uses default unless --profile selects another profile. Recovery preserves cookies and local storage.",
    restart: "Save your work and restart the computer running this backend, then run profile recover again with a new idempotency key. This older or interrupted claim lacks complete writer evidence; restarting only Dure is insufficient. Keep the profile and its lock files intact.",
    wait: "Close the Browser using this profile through its owning Dure backend, then inspect profile status and retry recovery with a new idempotency key. A live owner or concurrent recovery still holds the profile.",
    inspect: "Writer ownership could not be verified. Keep the profile intact and inspect the owning backend's diagnostics; do not delete native-claim.json or Chromium lock files.",
  }[action];
  return nextAction ? { ...error, ...(recovery ? { profileRecovery: recovery } : {}), nextAction: `${nextAction} To continue separately without changing this profile, run dure browser tab profile create --label temporary --scope isolated, then dure browser create --profile NEW_PROFILE_ID using the returned profile ID on the same backend. The isolated profile has separate sign-ins and site data.` } : error;
}

/** Enrich a refused creation with one bounded observation, never a recovery or
 * mutation retry. Older/unreachable backends retain the original diagnostic. */
export async function explainProfileRecoveryFailure(error, profileId, readStatus) {
  let recovery;
  if ((error?.remoteCode ?? error?.code) === "browser_profile_exit_unconfirmed" && profileId && readStatus) {
    try {
      const observed = await readStatus({ kind: "profile_recovery_status", profile_id: profileId });
      const status = observed?.result;
      if (!observed?.error && status?.profile_id === profileId
          && ["available", "live", "recoverable", "restart_required", "unconfirmed"].includes(status.state)) {
        recovery = { profileId, state: status.state };
      }
    } catch { /* Observation failure does not replace the failed creation. */ }
  }
  return profileRecoveryFailure(error, recovery);
}

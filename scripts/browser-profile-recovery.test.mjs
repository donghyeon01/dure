import { test, expect } from "vitest";
import { profileRecoveryFailure } from "../cli/lib/browser-profile-recovery.mjs";
import { browserProfileRecoveryAction } from "../cli/lib/contracts/browser-profile-recovery.mjs";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";

test.each([
  ["browser_profile_exit_unconfirmed", "recover", "profile recover"],
  ["browser_profile_recovery_restart_required", "restart", "restart the computer"],
  ["browser_profile_owner_live", "wait", "Close the Browser"],
  ["browser_profile_recovery_in_progress", "wait", "concurrent recovery"],
  ["browser_profile_recovery_unconfirmed", "inspect", "Keep the profile intact"],
])("%s provides actionable guidance without changing the backend failure", (remoteCode, action, instruction) => {
  const failure = {code:"backend_transport_remote_error", remoteCode, disposition:"terminal"};
  expect(browserProfileRecoveryAction(remoteCode)).toBe(action);
  expect(profileRecoveryFailure(failure)).toMatchObject(failure);
  expect(profileRecoveryFailure(failure).nextAction).toContain(instruction);
});

test("unrelated errors are unchanged", () => {
  const error = {code:"browser_action_failed"};
  expect(profileRecoveryFailure(error)).toBe(error);
});

test("a replayed failed operation retains actionable recovery guidance", async () => {
  const {collectBrowserCommand} = await import("../cli/lib/browser-command.mjs");
  const result = await collectBrowserCommand({args:["create", "--idempotency-key", "failed-once"],
    resolveBackend:async()=>({profile:{id:"local"}}),
    requestBackend:async()=>({result:{replayed:true,result:null,error:{code:"browser_profile_exit_unconfirmed"},receipt:{state:"failed"}}}),
  });
  expect(result.ok).toBe(false);
  expect(result.error.nextAction).toContain("profile recover");
});

test.each(["remote", "replay"])("%s create failure reports the observed restart requirement and a separate-profile alternative", async (failureKind) => {
  const calls = [];
  const result = await collectBrowserCommand({ args: ["create", "--idempotency-key", "create-once"], sourceEnvironment: {},
    resolveBackend: async () => ({ profile: { id: "selected", transport: { kind: "ssh" } } }),
    requestBackend: async (profile, request, transport) => {
      calls.push(request.body);
      expect(profile.id).toBe("selected");
      if (request.body.kind === "create") {
        if (failureKind === "remote") throw new BackendTransportError("backend_transport_remote_error", { details: { code: "browser_profile_exit_unconfirmed", disposition: "terminal" } });
        return { result: { replayed: true, result: null, error: { code: "browser_profile_exit_unconfirmed" }, receipt: { state: "failed" } } };
      }
      expect(request.body).toEqual({ kind: "profile_recovery_status", profile_id: "default" });
      expect(request.requiredCapabilities).toContain("browser.profile_recovery.v1");
      expect(transport.deadlineMs).toBeLessThanOrEqual(2500);
      return { result: { result: { profile_id: "default", state: "restart_required" } } };
    },
  });
  expect(result.ok).toBe(false);
  expect(result.operation_id).toBe("create-once");
  expect(result.error.remoteCode ?? result.error.code).toBe("browser_profile_exit_unconfirmed");
  expect(result.error.profileRecovery).toEqual({ profileId: "default", state: "restart_required" });
  expect(result.error.nextAction).toContain("restart the computer running this backend");
  expect(result.error.nextAction).toContain("--scope isolated");
  expect(result.error.nextAction).toContain("browser create --profile");
  expect(calls.map((call) => call.kind)).toEqual(["create", "profile_recovery_status"]);
});

test.each(["live", "recoverable", "unconfirmed", "unavailable", "wrong-profile", "malformed"])("profile diagnostics preserve the original failure when status is %s", async (state) => {
  const result = await collectBrowserCommand({ args: ["create", "--profile", "profile:selected", "--idempotency-key", "create-once"], sourceEnvironment: {},
    resolveBackend: async () => ({ profile: { id: "selected" } }),
    requestBackend: async (_profile, { body }) => {
      if (body.kind === "create") return { result: { error: { code: "browser_profile_exit_unconfirmed" } } };
      expect(body).toEqual({ kind: "profile_recovery_status", profile_id: "profile:selected" });
      if (state === "unavailable") throw new Error("old backend or read timeout");
      return { result: { result: { profile_id: state === "wrong-profile" ? "other" : body.profile_id, state: state === "wrong-profile" ? "restart_required" : state } } };
    },
  });
  expect(result.ok).toBe(false);
  expect(result.error.code).toBe("browser_profile_exit_unconfirmed");
  if (["live", "recoverable", "unconfirmed"].includes(state)) {
    expect(result.error.profileRecovery).toEqual({ profileId: "profile:selected", state });
    expect(result.error.nextAction).toContain({live:"Close the Browser",recoverable:"profile recover",unconfirmed:"Keep the profile intact"}[state]);
  } else expect(result.error.profileRecovery).toBeUndefined();
  expect(result.error.nextAction).toContain("--scope isolated");
});

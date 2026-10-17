use std::time::Duration;

use dure_app::{AgentProviderPromptTargetV1, ProviderIdV1};
use dure_provider_adapter::native_provider_prompt_target;
use hmux_client::{
    ClientError, TerminalAgentPromptError, TerminalAgentPromptReceipt, TerminalCommandInputError,
    TerminalCommandInputReceipt, TerminalSurfaceAttachment,
};
use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct HmuxSemanticInputReceipt {
    record_id: String,
    state: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HmuxCommandInputReceipt {
    terminal_epoch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<HmuxSemanticInputReceipt>,
    #[serde(skip_serializing_if = "Option::is_none")]
    submit: Option<HmuxSemanticInputReceipt>,
    /// Text and submit share one draft-guarded Host record.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    atomic: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HmuxInitialAgentPromptReceipt {
    terminal_epoch: String,
    record_id: String,
    input_baseline_output_sequence: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    initial_agent_runtime_revision: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HmuxInputFailure {
    code: String,
    message: String,
    delivery_state: &'static str,
}

impl HmuxInputFailure {
    pub(crate) fn not_written(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            delivery_state: "not_written",
        }
    }

    pub(crate) fn unknown(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            delivery_state: "unknown",
        }
    }

    pub(crate) fn from_client(error: ClientError) -> Self {
        Self::not_written(error.code(), error.to_string())
    }

    pub(crate) fn from_command_input(error: TerminalCommandInputError) -> Self {
        Self {
            code: error.code().to_string(),
            message: error.to_string(),
            delivery_state: error.delivery_state(),
        }
    }

    pub(crate) fn from_agent_prompt(error: TerminalAgentPromptError) -> Self {
        Self {
            code: error.code().to_string(),
            message: error.to_string(),
            delivery_state: error.delivery_state(),
        }
    }
}

impl std::fmt::Display for HmuxInputFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

pub(crate) fn project_command_input_receipt(
    receipt: &TerminalCommandInputReceipt,
) -> HmuxCommandInputReceipt {
    HmuxCommandInputReceipt {
        terminal_epoch: receipt.terminal_epoch().to_string(),
        text: receipt.text().map(|receipt| HmuxSemanticInputReceipt {
            record_id: receipt.in_reply_to_record_id.to_string(),
            state: "written_to_pty",
        }),
        submit: receipt.submit().map(|receipt| HmuxSemanticInputReceipt {
            record_id: receipt.in_reply_to_record_id.to_string(),
            state: "written_to_pty",
        }),
        atomic: receipt.atomic(),
    }
}

/// Sends one command input, through the Host draft guard when the caller
/// asked for it. A guarded request never falls back to ordinary input.
pub(crate) fn send_command_input(
    surface: &mut TerminalSurfaceAttachment,
    text: String,
    submit: bool,
    draft_guard_wait_ms: Option<u32>,
    timeout: Duration,
) -> Result<HmuxCommandInputReceipt, HmuxInputFailure> {
    let receipt = match draft_guard_wait_ms {
        Some(wait_ms) if wait_ms > terminal_state_protocol::MAX_DRAFT_GUARD_ADMISSION_WAIT_MS => {
            return Err(HmuxInputFailure::not_written(
                "hmux_command_input_invalid",
                "draft guard wait exceeds its bound",
            ));
        }
        Some(wait_ms) => {
            let draft_wait = Duration::from_millis(u64::from(wait_ms));
            surface.send_draft_guarded_command_input_confirmed(
                text,
                submit,
                draft_wait,
                draft_wait + timeout,
            )
        }
        None => surface.send_command_input_confirmed(text, submit, timeout),
    }
    .map_err(HmuxInputFailure::from_command_input)?;
    Ok(project_command_input_receipt(&receipt))
}

pub(crate) fn project_agent_prompt_receipt(
    receipt: &TerminalAgentPromptReceipt,
) -> HmuxInitialAgentPromptReceipt {
    HmuxInitialAgentPromptReceipt {
        terminal_epoch: receipt.terminal_epoch().to_string(),
        record_id: receipt.input().in_reply_to_record_id.to_string(),
        input_baseline_output_sequence: receipt.input_baseline_output_sequence().to_string(),
        initial_agent_runtime_revision: receipt
            .admitted_agent_runtime_revision()
            .map(|revision| revision.to_string()),
    }
}

fn provider_fresh_prompt_target(provider_id: &str) -> AgentProviderPromptTargetV1 {
    ProviderIdV1::new(provider_id)
        .ok()
        .and_then(|provider_id| native_provider_prompt_target(&provider_id, None))
        .unwrap_or_default()
}

pub(crate) fn send_fresh_agent_prompt(
    surface: &mut TerminalSurfaceAttachment,
    provider_id: &str,
    prompt: String,
    timeout: Duration,
) -> Result<HmuxInitialAgentPromptReceipt, HmuxInputFailure> {
    let receipt = match provider_fresh_prompt_target(provider_id) {
        AgentProviderPromptTargetV1::ProviderEvent => {
            surface.send_fresh_agent_prompt_confirmed(prompt, timeout)
        }
        AgentProviderPromptTargetV1::ProcessObserved
        | AgentProviderPromptTargetV1::LaunchArgument => {
            // LaunchArgument is the preferred managed-create path. This
            // endpoint remains the explicit fallback when that create receipt
            // says the launch did not accept the prompt (old backend, custom
            // command, or bounded argv overflow).
            surface.send_process_observed_fresh_agent_prompt_confirmed(prompt, timeout)
        }
    }
    .map_err(HmuxInputFailure::from_agent_prompt)?;
    Ok(project_agent_prompt_receipt(&receipt))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_adapter_is_the_only_fresh_prompt_target_authority() {
        for provider_id in ["codex", "claude"] {
            assert_eq!(
                provider_fresh_prompt_target(provider_id),
                AgentProviderPromptTargetV1::LaunchArgument
            );
        }
        for provider_id in ["kimi", "unknown"] {
            assert_eq!(
                provider_fresh_prompt_target(provider_id),
                AgentProviderPromptTargetV1::ProviderEvent
            );
        }
    }

    #[test]
    fn local_windows_and_ssh_share_one_command_receipt_shape() {
        let receipt = HmuxCommandInputReceipt {
            terminal_epoch: "terminal-1".into(),
            text: Some(HmuxSemanticInputReceipt {
                record_id: "7".into(),
                state: "written_to_pty",
            }),
            submit: Some(HmuxSemanticInputReceipt {
                record_id: "8".into(),
                state: "written_to_pty",
            }),
            atomic: false,
        };

        assert_eq!(
            serde_json::to_value(receipt).unwrap(),
            serde_json::json!({
                "terminalEpoch": "terminal-1",
                "text": { "recordId": "7", "state": "written_to_pty" },
                "submit": { "recordId": "8", "state": "written_to_pty" }
            })
        );

        let guarded = HmuxCommandInputReceipt {
            terminal_epoch: "terminal-1".into(),
            text: Some(HmuxSemanticInputReceipt {
                record_id: "9".into(),
                state: "written_to_pty",
            }),
            submit: Some(HmuxSemanticInputReceipt {
                record_id: "9".into(),
                state: "written_to_pty",
            }),
            atomic: true,
        };
        assert_eq!(
            serde_json::to_value(guarded).unwrap(),
            serde_json::json!({
                "terminalEpoch": "terminal-1",
                "text": { "recordId": "9", "state": "written_to_pty" },
                "submit": { "recordId": "9", "state": "written_to_pty" },
                "atomic": true
            })
        );
    }

    #[test]
    fn agent_prompt_receipt_preserves_optional_runtime_revision() {
        let receipt = HmuxInitialAgentPromptReceipt {
            terminal_epoch: "terminal-1".into(),
            record_id: "9".into(),
            input_baseline_output_sequence: "12".into(),
            initial_agent_runtime_revision: Some("3".into()),
        };
        assert_eq!(
            serde_json::to_value(receipt).unwrap(),
            serde_json::json!({
                "terminalEpoch": "terminal-1",
                "recordId": "9",
                "inputBaselineOutputSequence": "12",
                "initialAgentRuntimeRevision": "3"
            })
        );

        let legacy = HmuxInitialAgentPromptReceipt {
            terminal_epoch: "terminal-1".into(),
            record_id: "10".into(),
            input_baseline_output_sequence: "12".into(),
            initial_agent_runtime_revision: None,
        };
        assert_eq!(
            serde_json::to_value(legacy).unwrap(),
            serde_json::json!({
                "terminalEpoch": "terminal-1",
                "recordId": "10",
                "inputBaselineOutputSequence": "12"
            })
        );
    }

    #[test]
    fn failure_delivery_certainty_is_explicit() {
        assert_eq!(
            serde_json::to_value(HmuxInputFailure::not_written("refused", "retry safely")).unwrap(),
            serde_json::json!({
                "code": "refused",
                "message": "retry safely",
                "deliveryState": "not_written"
            })
        );
        assert_eq!(
            serde_json::to_value(HmuxInputFailure::unknown("transport", "inspect first")).unwrap(),
            serde_json::json!({
                "code": "transport",
                "message": "inspect first",
                "deliveryState": "unknown"
            })
        );
    }
}

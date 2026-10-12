use serde::{Deserialize, Serialize};

use super::validate_schema;
use crate::domain::{
    CapabilityRef, DispatchDeadline, DispatchState, InteractionTarget, Revision, ValidationError,
    validate_idempotency_key, validate_timestamp,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetDispatchDeadlineRequest {
    pub schema_version: u16,
    pub target: InteractionTarget,
    pub write_capability: CapabilityRef,
    pub expected_dispatch_revision: Revision,
    pub idempotency_key: String,
    /// Absolute Unix milliseconds. None explicitly clears the deadline.
    #[serde(deserialize_with = "Deserialize::deserialize")]
    pub due_at_ms: Option<i64>,
    pub changed_at_ms: i64,
}

impl SetDispatchDeadlineRequest {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_schema(self.schema_version)?;
        self.target.validate()?;
        self.write_capability.validate()?;
        self.expected_dispatch_revision.validate()?;
        validate_idempotency_key(&self.idempotency_key)?;
        validate_timestamp("changedAtMs", self.changed_at_ms)?;
        if let Some(due_at_ms) = self.due_at_ms {
            validate_timestamp("dueAtMs", due_at_ms)?;
            if due_at_ms > 9_007_199_254_740_991 {
                return Err(ValidationError {
                    field: "dueAtMs",
                    code: "out_of_range",
                });
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetDispatchDeadlineRequest {
    pub schema_version: u16,
    pub target: InteractionTarget,
    pub read_capability: CapabilityRef,
}

impl GetDispatchDeadlineRequest {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_schema(self.schema_version)?;
        self.target.validate()?;
        self.read_capability.validate()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DispatchDeadlineReceipt {
    pub target: InteractionTarget,
    pub dispatch_revision: Revision,
    pub dispatch_state: DispatchState,
    pub deadline: Option<DispatchDeadline>,
    pub idempotent: bool,
}

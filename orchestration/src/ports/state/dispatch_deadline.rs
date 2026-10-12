use super::*;
use crate::contract::{
    DispatchDeadlineReceipt, GetDispatchDeadlineRequest, SetDispatchDeadlineRequest,
};
use crate::domain::{Audience, AudienceGrant, DispatchDeadline, InteractionId};

impl StoreState {
    pub fn dispatch_deadline(
        &self,
        request: &GetDispatchDeadlineRequest,
    ) -> Result<DispatchDeadlineReceipt, StoreError> {
        let dispatch = &self.dispatches[self.dispatch_index(&request.target)?];
        if dispatch.interaction_capability != request.read_capability {
            return Err(StoreError::CapabilityDenied);
        }
        Ok(deadline_receipt(dispatch))
    }

    pub fn set_dispatch_deadline(
        &mut self,
        request: SetDispatchDeadlineRequest,
        fingerprint: String,
    ) -> Result<DispatchDeadlineReceipt, StoreError> {
        let index = self.dispatch_index(&request.target)?;
        if self.dispatches[index].interaction_capability != request.write_capability {
            return Err(StoreError::CapabilityDenied);
        }
        let key = scoped_operation_key("deadline", &request.target, &request.idempotency_key);
        if let Some(entry) = self.idempotency.get(&key) {
            return match (&entry.receipt, entry.fingerprint == fingerprint) {
                (StoredReceipt::Deadline(receipt), true) => {
                    let mut receipt = receipt.clone();
                    receipt.idempotent = true;
                    Ok(receipt)
                }
                _ => Err(StoreError::IdempotencyConflict),
            };
        }
        let dispatch = &mut self.dispatches[index];
        if dispatch.revision != request.expected_dispatch_revision {
            return Err(StoreError::RevisionConflict);
        }
        if dispatch.state == DispatchState::Completed {
            return Err(StoreError::StateConflict {
                code: "dispatch_completed",
            });
        }
        dispatch.revision = next_revision(dispatch.revision)?;
        dispatch.deadline = request.due_at_ms.map(|due_at_ms| DispatchDeadline {
            due_at_ms,
            overdue_event_cursor: None,
        });
        let grant = dispatch.coordinator_grant.clone();
        let receipt = deadline_receipt(dispatch);
        let description = match request.due_at_ms {
            Some(due) => format!("The dispatch deadline is now Unix time {due} milliseconds. The deadline is an attention signal; it does not interrupt the worker or determine task completion."),
            None => "The dispatch deadline has been cleared. Existing overdue observations remain in the event history.".into(),
        };
        self.deadline_message(
            request.target,
            grant,
            "Dispatch deadline updated",
            description,
            request.changed_at_ms,
        )?;
        self.idempotency.insert(
            key,
            IdempotencyEntry {
                fingerprint,
                receipt: StoredReceipt::Deadline(receipt.clone()),
            },
        );
        Ok(receipt)
    }

    // Use the existing Message/Event envelope so older GUI and inbox readers
    // can display deadline attention without learning a new event discriminator.
    fn deadline_message(
        &mut self,
        target: InteractionTarget,
        grant: AudienceGrant,
        title: &str,
        description_markdown: String,
        now_ms: i64,
    ) -> Result<Event, StoreError> {
        let id = InteractionId::new(format!(
            "deadline-{:x}",
            Sha256::digest(
                stable_key([
                    scope_key(&target.authority).as_str(),
                    &self.next_cursor.to_string()
                ])
                .as_bytes()
            )
        ))
        .map_err(|_| StoreError::Corrupt {
            code: "deadline_message_identity_invalid",
        })?;
        let record = InteractionRecord::Message {
            common: InteractionCommon {
                id: id.clone(),
                target: target.clone(),
                author: grant.participant.clone(),
                audience: Audience {
                    grants: vec![grant.clone()],
                },
                title: title.into(),
                description_markdown,
                revision: Revision::INITIAL,
                created_at_ms: now_ms,
            },
            purpose: MessagePurpose::Update,
        };
        record.validate().map_err(|_| StoreError::Corrupt {
            code: "deadline_message_invalid",
        })?;
        let event = self.append_event(
            target,
            grant.participant.clone(),
            EventKind::InteractionOpened { interaction_id: id },
            now_ms,
        )?;
        self.queue_deliveries(&record, std::slice::from_ref(&event))?;
        self.interactions.push(record);
        Ok(event)
    }

    /// Called by the backend clock, not a client observation. Event, delivery and
    /// deduplication marker commit in the same transaction. This is attention;
    /// it neither changes the dispatch revision/state nor wakes/interrupts a worker.
    pub fn expire_dispatch_deadlines(&mut self, now_ms: i64) -> Result<usize, StoreError> {
        let mut count = 0;
        for index in 0..self.dispatches.len() {
            let dispatch = &self.dispatches[index];
            let Some(deadline) = &dispatch.deadline else {
                continue;
            };
            if dispatch.state == DispatchState::Completed
                || deadline.due_at_ms > now_ms
                || deadline.overdue_event_cursor.is_some()
            {
                continue;
            }
            let target = dispatch.target.clone();
            let grant = dispatch.coordinator_grant.clone();
            let due_at_ms = deadline.due_at_ms;
            let event = self.deadline_message(target, grant, "Dispatch overdue",
                format!("The dispatch was still incomplete when the backend checked its deadline (due at Unix time {due_at_ms} milliseconds; observed at {now_ms}). Inspect the worker and durable completion state. This observation does not establish failure or authorize interruption."), now_ms)?;
            self.dispatches[index]
                .deadline
                .as_mut()
                .expect("deadline selected")
                .overdue_event_cursor = Some(event.cursor);
            count += 1;
        }
        Ok(count)
    }
}

fn deadline_receipt(dispatch: &DispatchRecord) -> DispatchDeadlineReceipt {
    DispatchDeadlineReceipt {
        target: dispatch.target.clone(),
        dispatch_revision: dispatch.revision,
        dispatch_state: dispatch.state,
        deadline: dispatch.deadline.clone(),
        idempotent: false,
    }
}

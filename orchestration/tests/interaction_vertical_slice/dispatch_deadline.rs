use super::*;
use agent_orchestration::contract::{GetDispatchDeadlineRequest, SetDispatchDeadlineRequest};
use agent_orchestration::ports::state::StoreState;

fn setting() -> SetDispatchDeadlineRequest {
    SetDispatchDeadlineRequest {
        schema_version: 1,
        target: target(),
        write_capability: capability("capability.open.interaction"),
        expected_dispatch_revision: Revision::INITIAL,
        idempotency_key: "deadline-1".into(),
        due_at_ms: Some(2000),
        changed_at_ms: 1000,
    }
}

#[test]
fn deadline_expiry_is_atomic_and_deduplicated_after_snapshot_restore() {
    let mut state = StoreState::seeded(vec![dispatch(&target())]).unwrap();
    state
        .set_dispatch_deadline(setting(), "a".repeat(64))
        .unwrap();
    assert_eq!(state.expire_dispatch_deadlines(1999).unwrap(), 0);
    let saved = serde_json::to_vec(&state).unwrap();
    let mut restored: StoreState = serde_json::from_slice(&saved).unwrap();
    assert_eq!(restored.expire_dispatch_deadlines(2000).unwrap(), 1);
    restored.validate().unwrap();
    assert_eq!(restored.dispatches[0].state, DispatchState::Active);
    assert_eq!(restored.dispatches[0].revision.get(), 2);
    let overdue = restored.dispatches[0]
        .deadline
        .as_ref()
        .unwrap()
        .overdue_event_cursor
        .unwrap();
    assert_eq!(restored.events.last().unwrap().cursor, overdue);
    assert_eq!(
        restored.interactions.last().unwrap().common().title,
        "Dispatch overdue"
    );
    assert!(
        restored
            .deliveries
            .iter()
            .all(|delivery| delivery.receipt.endpoint.is_none() && delivery.receipt.wake.is_none())
    );
    let saved = serde_json::to_vec(&restored).unwrap();
    let mut restored: StoreState = serde_json::from_slice(&saved).unwrap();
    assert_eq!(restored.expire_dispatch_deadlines(9000).unwrap(), 0);
    assert_eq!(restored.events.len(), 2);
    assert_eq!(restored.deliveries.len(), 2);
}

#[tokio::test]
async fn deadline_writes_require_exact_authority_revision_and_payload() {
    let service = InteractionService::new(in_memory_store(vec![dispatch(&target())]).unwrap());
    let request = setting();
    let receipt = service
        .set_dispatch_deadline(request.clone())
        .await
        .unwrap();
    assert_eq!(receipt.dispatch_revision.get(), 2);
    assert!(
        service
            .set_dispatch_deadline(request.clone())
            .await
            .unwrap()
            .idempotent
    );
    let mut conflict = request.clone();
    conflict.due_at_ms = Some(3000);
    assert_eq!(
        service.set_dispatch_deadline(conflict).await,
        Err(ServiceError::IdempotencyConflict)
    );
    let mut stale = request.clone();
    stale.idempotency_key = "deadline-stale".into();
    assert_eq!(
        service.set_dispatch_deadline(stale).await,
        Err(ServiceError::RevisionConflict)
    );
    let mut denied = request.clone();
    denied.write_capability = capability("wrong-capability");
    assert_eq!(
        service.set_dispatch_deadline(denied).await,
        Err(ServiceError::CapabilityDenied)
    );
    let mut stale = request;
    stale.target.generation = Generation::new(8).unwrap();
    assert_eq!(
        service.set_dispatch_deadline(stale).await,
        Err(ServiceError::GenerationConflict)
    );
    let mut read = GetDispatchDeadlineRequest {
        schema_version: 1,
        target: target(),
        read_capability: capability("wrong-capability"),
    };
    assert_eq!(
        service.dispatch_deadline(read.clone()).await,
        Err(ServiceError::CapabilityDenied)
    );
    read.read_capability = capability("capability.open.interaction");
    assert_eq!(
        service
            .dispatch_deadline(read)
            .await
            .unwrap()
            .deadline
            .unwrap()
            .due_at_ms,
        2000
    );
}

#[test]
fn clearing_or_completion_prevents_new_overdue_attention() {
    for complete in [false, true] {
        let mut state = StoreState::seeded(vec![dispatch(&target())]).unwrap();
        state
            .set_dispatch_deadline(setting(), "a".repeat(64))
            .unwrap();
        if complete {
            state.dispatches[0].state = DispatchState::Completed;
        } else {
            let mut clear = setting();
            clear.expected_dispatch_revision = Revision::new(2).unwrap();
            clear.idempotency_key = "clear-deadline".into();
            clear.due_at_ms = None;
            state.set_dispatch_deadline(clear, "b".repeat(64)).unwrap();
        }
        assert!(
            state
                .set_dispatch_deadline(setting(), "a".repeat(64))
                .unwrap()
                .idempotent
        );
        assert_eq!(state.expire_dispatch_deadlines(9000).unwrap(), 0);
        assert!(
            !state
                .interactions
                .iter()
                .any(|item| item.common().title == "Dispatch overdue")
        );
    }
}

#[test]
fn blocked_dispatch_stays_blocked_and_reset_keeps_prior_overdue_history() {
    let mut state = StoreState::seeded(vec![dispatch(&target())]).unwrap();
    state
        .set_dispatch_deadline(setting(), "a".repeat(64))
        .unwrap();
    let mut decision = decision_request(&target());
    decision.expected_dispatch_revision = Revision::new(2).unwrap();
    state.open(decision, "c".repeat(64)).unwrap();
    assert_eq!(state.expire_dispatch_deadlines(2000).unwrap(), 1);
    assert_eq!(state.dispatches[0].state, DispatchState::Blocked);
    let mut reset = setting();
    reset.idempotency_key = "reset-deadline".into();
    reset.expected_dispatch_revision = Revision::new(3).unwrap();
    reset.due_at_ms = Some(4000);
    state.set_dispatch_deadline(reset, "b".repeat(64)).unwrap();
    assert_eq!(state.expire_dispatch_deadlines(3000).unwrap(), 0);
    assert_eq!(state.expire_dispatch_deadlines(4000).unwrap(), 1);
    assert_eq!(
        state
            .interactions
            .iter()
            .filter(|item| item.common().title == "Dispatch overdue")
            .count(),
        2
    );
}

#[test]
fn invalid_deadlines_are_rejected_at_the_service_boundary() {
    for due in [-1, 9_007_199_254_740_992] {
        let mut request = setting();
        request.due_at_ms = Some(due);
        assert!(request.validate().is_err());
    }
}

#[test]
fn clearing_requires_an_explicit_null_due_time() {
    let mut value = serde_json::to_value(setting()).unwrap();
    value.as_object_mut().unwrap().remove("dueAtMs");
    assert!(serde_json::from_value::<SetDispatchDeadlineRequest>(value.clone()).is_err());
    value["dueAtMs"] = serde_json::Value::Null;
    assert!(
        serde_json::from_value::<SetDispatchDeadlineRequest>(value)
            .unwrap()
            .due_at_ms
            .is_none()
    );
}

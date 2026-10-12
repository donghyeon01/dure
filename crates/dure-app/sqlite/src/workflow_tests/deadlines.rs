use super::*;
use agent_orchestration::contract::{
    EventAcknowledgement, GetDispatchDeadlineRequest, SetDispatchDeadlineRequest,
};

fn setting(context: &DispatchContextReceipt) -> SetDispatchDeadlineRequest {
    SetDispatchDeadlineRequest {
        schema_version: 1,
        target: context.target.clone(),
        write_capability: context.interaction_capability.clone(),
        expected_dispatch_revision: context.dispatch_revision,
        idempotency_key: "deadline-fixture".into(),
        due_at_ms: Some(3000),
        changed_at_ms: 2000,
    }
}

fn reading(context: &DispatchContextReceipt) -> GetDispatchDeadlineRequest {
    GetDispatchDeadlineRequest {
        schema_version: 1,
        target: context.target.clone(),
        read_capability: context.interaction_capability.clone(),
    }
}

#[tokio::test]
async fn deadline_survives_restart_concurrent_ticks_and_cursor_acknowledgement() {
    let root = tempdir().unwrap();
    let path = root.path().join("deadline.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let context = prepare_orchestration_context(&store, "deadline").await;
    let request = setting(&context);
    store
        .interaction_service()
        .set_dispatch_deadline(request.clone())
        .await
        .unwrap();
    assert_eq!(store.expire_dispatch_deadlines(2999).await.unwrap(), 0);
    store.close().await;

    let store = SqliteDomainStore::open(&path).await.unwrap();
    let (first, second) = tokio::join!(
        store.expire_dispatch_deadlines(3000),
        store.expire_dispatch_deadlines(3000)
    );
    assert_eq!(first.unwrap() + second.unwrap(), 1);
    let inspected = store
        .interaction_service()
        .dispatch_deadline(reading(&context))
        .await
        .unwrap();
    assert_eq!(inspected.dispatch_state, DispatchState::Active);
    assert_eq!(inspected.dispatch_revision.get(), 2);
    let overdue_cursor = inspected.deadline.unwrap().overdue_event_cursor.unwrap();
    let events = store
        .interaction_service()
        .read_events(coordinator_event_read(&context, EventCursor::new(0)))
        .await
        .unwrap();
    assert_eq!(events.events.last().unwrap().cursor, overdue_cursor);
    assert!(
        events
            .deliveries
            .iter()
            .all(|delivery| delivery.endpoint.is_none() && delivery.wake.is_none())
    );
    let mut acknowledge = coordinator_event_read(&context, events.next_cursor);
    acknowledge.acknowledgement = Some(EventAcknowledgement {
        through: overdue_cursor,
        idempotency_key: "ack-overdue".into(),
        acknowledgement_capability: context.coordinator_grant.delivery_capability.clone(),
    });
    store
        .interaction_service()
        .read_events(acknowledge)
        .await
        .unwrap();
    store.close().await;

    let store = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(store.expire_dispatch_deadlines(9000).await.unwrap(), 0);
    assert!(
        store
            .interaction_service()
            .set_dispatch_deadline(request)
            .await
            .unwrap()
            .idempotent
    );
    let events = store
        .interaction_service()
        .read_events(coordinator_event_read(&context, overdue_cursor))
        .await
        .unwrap();
    assert!(events.events.is_empty());
    assert!(
        store
            .interaction_service()
            .dispatch_deadline(reading(&context))
            .await
            .unwrap()
            .deadline
            .unwrap()
            .overdue_event_cursor
            .is_some()
    );
    store.close().await;
}

#[tokio::test]
async fn failed_overdue_event_rolls_back_marker_and_retries_once() {
    let root = tempdir().unwrap();
    let path = root.path().join("deadline.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let context = prepare_orchestration_context(&store, "deadline-fault").await;
    store
        .interaction_service()
        .set_dispatch_deadline(setting(&context))
        .await
        .unwrap();
    sqlx::query("CREATE TRIGGER fail_overdue BEFORE INSERT ON workflow_interactions WHEN json_extract(NEW.record_json, '$.common.title') = 'Dispatch overdue' BEGIN SELECT RAISE(ABORT, 'fixture'); END").execute(&store.pool).await.unwrap();
    assert!(store.expire_dispatch_deadlines(3000).await.is_err());
    assert!(
        store
            .interaction_service()
            .dispatch_deadline(reading(&context))
            .await
            .unwrap()
            .deadline
            .unwrap()
            .overdue_event_cursor
            .is_none()
    );
    sqlx::query("DROP TRIGGER fail_overdue")
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(store.expire_dispatch_deadlines(3000).await.unwrap(), 1);
    assert_eq!(store.expire_dispatch_deadlines(4000).await.unwrap(), 0);
    store.close().await;
}

#[tokio::test]
async fn completion_wins_before_deadline_and_clear_survives_restart() {
    for complete in [false, true] {
        let root = tempdir().unwrap();
        let path = root.path().join("deadline.sqlite");
        let store = SqliteDomainStore::open(&path).await.unwrap();
        let mut context = prepare_orchestration_context(&store, "deadline-complete").await;
        let receipt = store
            .interaction_service()
            .set_dispatch_deadline(setting(&context))
            .await
            .unwrap();
        context.dispatch_revision = receipt.dispatch_revision;
        if complete {
            complete_orchestration_context(&store, &context, "deadline-complete", 2500).await;
        } else {
            let mut clear = setting(&context);
            clear.idempotency_key = "clear-deadline".into();
            clear.due_at_ms = None;
            store
                .interaction_service()
                .set_dispatch_deadline(clear)
                .await
                .unwrap();
        }
        store.close().await;
        let store = SqliteDomainStore::open(&path).await.unwrap();
        assert_eq!(store.expire_dispatch_deadlines(4000).await.unwrap(), 0);
        if complete {
            assert_eq!(
                store
                    .interaction_service()
                    .dispatch_deadline(reading(&context))
                    .await
                    .unwrap()
                    .dispatch_state,
                DispatchState::Completed
            );
        } else {
            assert!(
                store
                    .interaction_service()
                    .dispatch_deadline(reading(&context))
                    .await
                    .unwrap()
                    .deadline
                    .is_none()
            );
        }
        store.close().await;
    }
}

#[tokio::test]
async fn schema_51_migration_preserves_existing_dispatch_without_deadline() {
    let root = tempdir().unwrap();
    let path = root.path().join("deadline.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let context = prepare_orchestration_context(&store, "deadline-migration").await;
    sqlx::query("ALTER TABLE workflow_interaction_authorities DROP COLUMN deadline_json")
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE store_metadata SET schema_version = 51 WHERE singleton = 1")
        .execute(&store.pool)
        .await
        .unwrap();
    store.close().await;
    let store = SqliteDomainStore::open(&path).await.unwrap();
    assert!(
        store
            .interaction_service()
            .dispatch_deadline(reading(&context))
            .await
            .unwrap()
            .deadline
            .is_none()
    );
    store
        .interaction_service()
        .set_dispatch_deadline(setting(&context))
        .await
        .unwrap();
    assert_eq!(store.expire_dispatch_deadlines(3000).await.unwrap(), 1);
    store.close().await;
}

use std::sync::Arc;
use tokio::time::{Duration, MissedTickBehavior};

use crate::ServiceState;

pub(crate) async fn run_loop(state: Arc<ServiceState>) {
    let mut interval = tokio::time::interval(Duration::from_secs(5));
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        if !state.is_mutation_authority() {
            continue;
        }
        let Ok(now) = crate::now_ms() else { continue };
        // A failed transaction leaves the deadline pending for the next tick.
        let _ = state.store.expire_dispatch_deadlines(now).await;
    }
}

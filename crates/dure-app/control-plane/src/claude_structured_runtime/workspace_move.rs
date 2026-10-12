use super::*;

impl ClaudeRuntimeContext {
    pub(super) fn at_workspace(
        &self,
        workspace: &dure_app::WorkspaceRecordV1,
    ) -> Result<Self, ClaudeStructuredRuntimeErrorV1> {
        let mut context = self.at_recorded_workspace(workspace)?;
        let cwd = exact_directory(&context.cwd)?;
        if cwd != context.cwd {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        context.cwd = cwd;
        Ok(context)
    }

    // Only persisted placement may use this path. Reading the exact provider
    // journal still checks its cwd/workspace/generation before any cleanup.
    pub(super) fn at_recorded_workspace(
        &self,
        workspace: &dure_app::WorkspaceRecordV1,
    ) -> Result<Self, ClaudeStructuredRuntimeErrorV1> {
        workspace
            .validate()
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RequestInvalid)?;
        let cwd = PathBuf::from(&workspace.root_path);
        if !cwd.is_absolute() {
            return Err(ClaudeStructuredRuntimeErrorV1::RequestInvalid);
        }
        Ok(Self {
            binding: self.binding.clone(),
            workspace_id: workspace.workspace_id.as_str().to_owned(),
            cwd,
        })
    }
}

impl<S> ClaudeStructuredRuntimeManager<S>
where
    S: AgentTimelineStore
        + AgentRuntimeTransitionStore
        + DomainStore
        + ProviderCredentialProfileStore
        + 'static,
{
    pub(crate) async fn open_workspace_replacement(
        &self,
        request: ClaudeStructuredOpenRequestV1,
        workspace: &dure_app::WorkspaceRecordV1,
        transition: &AgentRuntimeTransitionRecordV1,
        environment: ProviderStateEnvironment,
    ) -> Result<ClaudeStructuredOpenReceiptV1, ClaudeStructuredReplacementFailureV1> {
        if transition
            .intent
            .workspace_move
            .as_ref()
            .map(|movement| &movement.target_workspace)
            != Some(workspace)
            || transition.intent.source.interaction_profile
                != AgentInteractionProfileV1::StructuredProtocol
        {
            return Err(ClaudeStructuredRuntimeErrorV1::RequestInvalid.into());
        }
        self.open_replacement_at(request, transition, environment, Some(workspace))
            .await
    }

    pub(crate) async fn quiesce_workspace_target(
        &self,
        transition: &AgentRuntimeTransitionRecordV1,
    ) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
        transition
            .validate()
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
        let Some(AgentRuntimeReplacementAuthorityV1(
            AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding },
        )) = &transition.replacement_authority
        else {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        };
        let workspace = transition
            .replacement_workspace
            .as_ref()
            .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
        let context = self
            .runtime_context_recorded(&binding.interaction_session_id, Some(workspace))
            .await?
            .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
        if context.binding != *binding {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        let slot = {
            let mut slots = self.slots.lock().await;
            Arc::clone(
                slots
                    .entry(binding.interaction_session_id.clone())
                    .or_insert_with(|| Arc::new(Mutex::new(None))),
            )
        };
        let mut active = slot.lock().await;
        if active.as_ref().is_some_and(|runtime| {
            !runtime.binding.same_runtime_authority(binding) || runtime.cwd != context.cwd
        }) {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        let mut prepared = self
            .read_runtime(binding, &context.workspace_id, &context.cwd)?
            .ok_or(ClaudeStructuredRuntimeErrorV1::JournalFailed)?;
        if matches!(
            prepared.journal.state(),
            ClaudeRuntimeLaunchStateV1::Attached | ClaudeRuntimeLaunchStateV1::QueryRetired
        ) {
            self.retire_query_before_stop(
                binding,
                &prepared.journal.query_identity(),
                &prepared.files.runtime_directory,
                &mut prepared.journal,
                false,
                None,
            )
            .await?;
        }
        if prepared.journal.state() != ClaudeRuntimeLaunchStateV1::Failed {
            self.record_managed_create_failure(
                &context.cwd,
                &mut prepared,
                ClaudeStructuredRecordedFailureV1::WorkspaceCommitRejected,
            )
            .await?;
        }
        active.take();
        drop(active);
        self.remove_idle_slot(&binding.interaction_session_id, &slot)
            .await;
        Ok(())
    }
}

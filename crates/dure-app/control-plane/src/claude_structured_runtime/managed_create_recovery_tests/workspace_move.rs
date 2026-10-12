use super::*;
use dure_app::{
    AgentRecordV1, AgentRuntimeSelectionV1, AgentRuntimeSourceStopPolicyV1,
    AgentRuntimeTargetFailureKindV1, AgentRuntimeTargetFailureV1, AgentRuntimeTransitionIntentV1,
    AgentRuntimeTransitionStateV1, AgentRuntimeWorkspaceMoveV1, OperationIdV1, ProjectIdV1,
    ProjectRecordV1, WorkspaceIdV1, WorkspaceRecordV1,
};

#[tokio::test]
async fn rejected_workspace_cleanup_and_source_repair_survive_missing_destination() {
    for boundary in ["rename", "remove", "symlink"] {
        let root = tempfile::Builder::new()
            .prefix("dcr-move-")
            .tempdir_in("/tmp")
            .unwrap();
        let source_path = root.path().join("source");
        let destination = root.path().join("destination");
        let unrelated = root.path().join("unrelated");
        for path in [&source_path, &destination, &unrelated] {
            owner_directory(path);
        }
        let runtime = fake_runtime(root.path());
        let mut manager = manager(root.path(), &runtime).await;
        let mut source = binding();
        source.runtime.runtime_generation = "source-runtime".into();
        let source_workspace = WorkspaceRecordV1 {
            workspace_id: WorkspaceIdV1::new("source-workspace").unwrap(),
            project_id: ProjectIdV1::new("source-project").unwrap(),
            root_path: source_path
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            base_commit_sha: None,
            created_at_ms: 1,
            updated_at_ms: 1,
        };
        let target_workspace = WorkspaceRecordV1 {
            workspace_id: WorkspaceIdV1::new("target-workspace").unwrap(),
            project_id: ProjectIdV1::new("target-project").unwrap(),
            root_path: destination
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            ..source_workspace.clone()
        };
        let source_project = ProjectRecordV1 {
            project_id: source_workspace.project_id.clone(),
            root_path: source_workspace.root_path.clone(),
            display_name: "Source".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        };
        manager.store.upsert_project(&source_project).await.unwrap();
        manager
            .store
            .upsert_workspace(&source_workspace)
            .await
            .unwrap();
        let agent = AgentRecordV1 {
            agent_id: source.agent_id.clone(),
            workspace_id: source_workspace.workspace_id.clone(),
            provider_id: source.provider_id.clone(),
            display_name: "Claude".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        };
        manager.store.upsert_agent(&agent).await.unwrap();
        manager.conversation_service.create(&source).await.unwrap();
        let target = manager
            .conversation_service
            .replace_runtime(&dure_app::AgentRuntimeReplacementV1 {
                schema_version: 1,
                interaction_session_id: source.interaction_session_id.clone(),
                expected_binding_revision: source.binding_revision,
                source: source.runtime.clone(),
                source_execution_profile: source.execution_profile.clone(),
                target: AgentProviderRuntimeFenceV1 {
                    runtime_generation: "failed-destination".into(),
                    provider_epoch: "failed-epoch".into(),
                },
                target_execution_profile: source.execution_profile.clone(),
                provider_conversation_ref: source.provider_conversation_ref.clone(),
                replaced_at_ms: 2,
            })
            .await
            .unwrap();
        let mut transition =
            AgentRuntimeTransitionRecordV1::admitted(AgentRuntimeTransitionIntentV1 {
                schema_version: 1,
                operation_id: OperationIdV1::new("move-rejected").unwrap(),
                idempotency_key: "move-rejected".into(),
                source: AgentRuntimeSelectionV1 {
                    schema_version: 1,
                    agent_id: agent.agent_id.clone(),
                    provider_id: source.provider_id.clone(),
                    interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
                    execution_profile: source.execution_profile.clone(),
                    permission_mode: ProviderPermissionModeV1::Default,
                    model: None,
                    effort: None,
                    revision: 1,
                    selected_by_operation_id: None,
                    updated_at_ms: 1,
                },
                source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                    binding: source.clone(),
                },
                source_stop_policy: AgentRuntimeSourceStopPolicyV1::Preserve,
                provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
                    source.provider_conversation_ref.as_ref().unwrap(),
                )
                .unwrap(),
                target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
                target_execution_profile: source.execution_profile.clone(),
                target_launch_selection: None,
                workspace_move: Some(AgentRuntimeWorkspaceMoveV1 {
                    source_agent: agent,
                    source_workspace: source_workspace.clone(),
                    source_checkout: None,
                    target_project: ProjectRecordV1 {
                        project_id: target_workspace.project_id.clone(),
                        root_path: target_workspace.root_path.clone(),
                        ..source_project
                    },
                    target_workspace: target_workspace.clone(),
                    registered_root_id: "registered".into(),
                    observed_root_id: "observed".into(),
                    registered_repository_id: "repository".into(),
                }),
                requested_at_ms: 2,
            })
            .unwrap();
        transition.state = AgentRuntimeTransitionStateV1::RepairRequired;
        transition.replacement_authority = Some(AgentRuntimeReplacementAuthorityV1(
            AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                binding: target.clone(),
            },
        ));
        transition.replacement_workspace = Some(target_workspace.clone());
        transition.target_failure = Some(AgentRuntimeTargetFailureV1 {
            kind: AgentRuntimeTargetFailureKindV1::TargetInvalid,
            provider_code: "destination_changed".into(),
        });
        transition.post_start_rejections = 1;
        transition.journal_revision = 4;
        transition.validate().unwrap();

        let mut prepared = manager
            .create_runtime(
                &target,
                target_workspace.workspace_id.as_str(),
                Path::new(&target_workspace.root_path),
                None,
            )
            .unwrap();
        let mut exact = descriptor(&prepared.files, target_workspace.workspace_id.as_str());
        // No native process is controlled: the fixture broker returns the exact
        // recorded fence, and the adapter independently probes proven absence.
        exact.host_process.process_id = 1_999_999_999;
        exact.host_process.start_marker = "1999999999-1".into();
        exact.provider_process.process_id = 1_999_999_999;
        exact.provider_process.start_marker = "1999999999-1".into();
        assert!(relay_generation_is_absent(&exact).unwrap());
        prepared.journal.relay_ready(exact.clone());
        prepared.journal.attached(std::process::id());
        // Persist the real post-retire/pre-Hmux-stop crash boundary. A restarted
        // manager must finish it without reacquiring or recreating the Query.
        prepared
            .journal
            .query_retired(ClaudeDch1ProviderRetirementAuthority {
                source: prepared.journal.query_identity(),
                allowed_target: None,
                source_host: ClaudeDch1HostIdentity {
                    host_generation: "fixture-host".into(),
                    host_instance_id: "fixture-instance".into(),
                },
                target_host: None,
                phase: ClaudeDch1ProviderRetirementPhase::Retired,
            });
        write_journal(&prepared.files.runtime_directory, &prepared.journal).unwrap();
        let mut other = source.clone();
        other.interaction_session_id =
            AgentInteractionSessionIdV1::new("unrelated-interaction").unwrap();
        let unrelated_runtime = manager
            .create_runtime(&other, "unrelated-workspace", &unrelated, None)
            .unwrap();
        let untouched = fs::read(
            unrelated_runtime
                .files
                .runtime_directory
                .join("launch.json"),
        )
        .unwrap();
        match boundary {
            "rename" => fs::rename(&destination, root.path().join("retained-destination")).unwrap(),
            "remove" => fs::remove_dir(&destination).unwrap(),
            _ => {
                fs::remove_dir(&destination).unwrap();
                std::os::unix::fs::symlink(&unrelated, &destination).unwrap();
            }
        }
        write_frame(
            &runtime.with_extension("stop-reconcile"),
            &ManagedStopBrokerResponse::refused(
                "hmux_managed_stop_intent_not_found",
                "no receipt yet",
            ),
        );
        write_frame(
            &runtime.with_extension("stop"),
            &ManagedStopBrokerResponse::refused("fixture_stop_refused", "retry exact cleanup"),
        );
        assert_eq!(
            manager
                .quiesce_workspace_target(&transition)
                .await
                .unwrap_err(),
            ClaudeStructuredRuntimeErrorV1::StopFailed,
            "a missing destination must not prevent reaching the exact stop broker"
        );
        assert_eq!(
            read_journal(&prepared.files.runtime_directory)
                .unwrap()
                .state(),
            ClaudeRuntimeLaunchStateV1::FailureCleanupPending
        );
        let request = ManagedStopRequest::new(
            format!(
                "claude-chat-failed-runtime-stop-{}",
                exact_stop_identity(&exact)
            ),
            &exact.session_id,
            &exact.workspace_id,
        )
        .and_then(|request| {
            request.with_expected_fence(
                &exact.runner_principal,
                &exact.runner_instance,
                exact.channel_epoch.parse().unwrap(),
                &exact.host_instance_id,
                &exact.terminal_epoch,
            )
        })
        .unwrap();
        write_frame(
            &runtime.with_extension("stop-reconcile"),
            &ManagedStopBrokerResponse::Completed(Box::new(
                ManagedStopReceipt::from_request(
                    &request,
                    ManagedStopOutcome::Stopped,
                    "replayed-exact-stop",
                )
                .unwrap(),
            )),
        );
        // Reopen durable binding and provider journal with empty manager slots.
        let store = Arc::new(
            SqliteDomainStore::open(manager.store.database_path())
                .await
                .unwrap(),
        );
        manager = ClaudeStructuredRuntimeManager::new(
            manager.configuration.clone(),
            Arc::clone(&manager.credential_profiles),
            Arc::new(AgentConversationService::new(Arc::clone(&store))),
            Arc::clone(&manager.host),
            store,
        );
        manager.quiesce_workspace_target(&transition).await.unwrap();
        manager.quiesce_workspace_target(&transition).await.unwrap();
        assert_eq!(
            read_journal(&prepared.files.runtime_directory)
                .unwrap()
                .state(),
            ClaudeRuntimeLaunchStateV1::Failed
        );
        assert_eq!(
            fs::read(
                unrelated_runtime
                    .files
                    .runtime_directory
                    .join("launch.json")
            )
            .unwrap(),
            untouched
        );
        let mut successor_intent = transition.intent.clone();
        successor_intent.operation_id = OperationIdV1::new("restore-source").unwrap();
        successor_intent.idempotency_key = "restore-source".into();
        successor_intent.workspace_move = None;
        successor_intent.requested_at_ms = 3;
        let (_, successor) = dure_app::supersede_agent_runtime_transition_v1(
            &transition,
            &dure_app::AgentRuntimeTransitionSupersedeRequestV1 {
                schema_version: 1,
                operation_id: transition.intent.operation_id.clone(),
                expected_journal_revision: transition.journal_revision,
                successor_intent,
                superseded_at_ms: 3,
            },
        )
        .unwrap();
        let request = ClaudeStructuredOpenRequestV1 {
            agent_id: target.agent_id.clone(),
            execution_profile: target.execution_profile.clone(),
            provider_conversation_ref: target.provider_conversation_ref.clone(),
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
        };
        let restored = manager
            .prepare_structured_replacement(&request, &successor, None)
            .await
            .unwrap();
        assert_eq!(
            manager
                .prepare_structured_replacement(&request, &successor, None)
                .await
                .unwrap(),
            restored,
            "response replay retains the exact replacement"
        );
        assert_eq!(
            restored.interaction_session_id,
            target.interaction_session_id
        );
        assert_eq!(
            restored.provider_conversation_ref,
            target.provider_conversation_ref
        );
        assert_eq!(restored.execution_profile, target.execution_profile);
        assert_eq!(
            manager
                .read_runtime(
                    &restored,
                    source_workspace.workspace_id.as_str(),
                    &source_path.canonicalize().unwrap()
                )
                .unwrap()
                .unwrap()
                .journal
                .state(),
            ClaudeRuntimeLaunchStateV1::Prepared
        );
        assert_eq!(
            fs::read_to_string(runtime.with_extension("calls")).unwrap(),
            format!(
                "{MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND}\n{MANAGED_STOP_BROKER_SUBCOMMAND}\n{MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND}\n"
            )
        );
    }
}

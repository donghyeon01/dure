use dure_app::{ProviderIdV1, ProviderPermissionModeV1};
use dure_provider_adapter::{
    NativeProviderConversationReference, native_provider_project_move,
    native_provider_session_launch_plan,
};

#[test]
fn project_move_pins_codex_working_root_in_both_launch_and_recovery_without_forking() {
    let provider = ProviderIdV1::new("codex").unwrap();
    let mut plan = native_provider_session_launch_plan(
        &provider,
        &ProviderPermissionModeV1::Default,
        None,
        None,
        NativeProviderConversationReference::Exact("conversation-1"),
        "__CONVERSATION__",
    )
    .unwrap()
    .unwrap();
    let original = plan.clone();
    let directory = std::env::temp_dir().join("new project");
    native_provider_project_move(&provider, &mut plan, &directory).unwrap();
    assert_eq!(
        &plan.launch.arguments[..2],
        &["--cd", directory.to_str().unwrap()]
    );
    assert_eq!(&plan.launch.arguments[2..], &original.launch.arguments);
    assert_eq!(
        &plan.resume_arguments.as_ref().unwrap()[..2],
        &["--cd", directory.to_str().unwrap()]
    );
    assert_eq!(
        &plan.resume_arguments.unwrap()[2..],
        &original.resume_arguments.unwrap()
    );
}

#[test]
fn claude_project_move_keeps_exact_resume_identity_and_recovery_without_history_copy_or_fork() {
    let provider = ProviderIdV1::new("claude").unwrap();
    let mut plan = native_provider_session_launch_plan(
        &provider,
        &ProviderPermissionModeV1::Default,
        None,
        None,
        NativeProviderConversationReference::Exact("019f0000-0000-7000-8000-000000000185"),
        "__CONVERSATION__",
    )
    .unwrap()
    .unwrap();
    let original = plan.clone();
    native_provider_project_move(&provider, &mut plan, std::path::Path::new("/workspace/new"))
        .unwrap();
    assert_eq!(plan, original);
    assert!(
        plan.launch
            .arguments
            .windows(2)
            .any(|pair| pair == ["--resume", "019f0000-0000-7000-8000-000000000185"])
    );
    assert!(
        !plan
            .launch
            .arguments
            .iter()
            .any(|argument| argument == "--fork-session")
    );
}

#[test]
fn claude_project_move_refuses_names_or_missing_history_identity_without_changing_arguments() {
    let provider = ProviderIdV1::new("claude").unwrap();
    for reference in [
        NativeProviderConversationReference::Exact("same-name"),
        NativeProviderConversationReference::Fresh,
    ] {
        let mut plan = native_provider_session_launch_plan(
            &provider,
            &ProviderPermissionModeV1::Default,
            None,
            None,
            reference,
            "__CONVERSATION__",
        )
        .unwrap()
        .unwrap();
        let original = plan.clone();
        assert!(
            native_provider_project_move(
                &provider,
                &mut plan,
                std::path::Path::new("/workspace/new")
            )
            .is_err()
        );
        assert_eq!(plan, original);
    }
}

#[test]
fn claude_project_move_refuses_fork_or_truncation_flags_in_launch_and_recovery() {
    let provider = ProviderIdV1::new("claude").unwrap();
    for flag in [
        "--fork-session",
        "--session-id=other",
        "--resume-session-at=older-turn",
    ] {
        for recovery in [false, true] {
            let mut plan = native_provider_session_launch_plan(
                &provider,
                &ProviderPermissionModeV1::Default,
                None,
                None,
                NativeProviderConversationReference::Exact("019f0000-0000-7000-8000-000000000185"),
                "__CONVERSATION__",
            )
            .unwrap()
            .unwrap();
            if recovery {
                plan.resume_arguments.as_mut().unwrap().push(flag.into());
            } else {
                plan.launch.arguments.push(flag.into());
            }
            assert!(
                native_provider_project_move(
                    &provider,
                    &mut plan,
                    std::path::Path::new("/workspace/new")
                )
                .is_err()
            );
        }
    }
}

#[test]
#[ignore = "requires DURE_QA_CODEX_BIN; parser-only provider acceptance"]
fn codex_accepts_project_move_plan() {
    let executable = std::env::var_os("DURE_QA_CODEX_BIN").expect("DURE_QA_CODEX_BIN");
    let temporary = std::env::temp_dir().join(format!(
        "dure-codex-move-parser-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&temporary).unwrap();
    let provider = ProviderIdV1::new("codex").unwrap();
    let mut plan = native_provider_session_launch_plan(
        &provider,
        &ProviderPermissionModeV1::Default,
        None,
        None,
        NativeProviderConversationReference::Exact("019f0000-0000-7000-8000-000000000185"),
        "__CONVERSATION__",
    )
    .unwrap()
    .unwrap();
    native_provider_project_move(&provider, &mut plan, temporary.as_path()).unwrap();
    let output = std::process::Command::new(executable)
        .args(plan.launch.arguments)
        .arg("--help")
        .env("HOME", temporary.as_path())
        .env("DURE_HOME", temporary.as_path().join("dure"))
        .env("HMUX_DISCOVERY_ROOT", temporary.as_path().join("discovery"))
        .output()
        .unwrap();
    std::fs::remove_dir_all(&temporary).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

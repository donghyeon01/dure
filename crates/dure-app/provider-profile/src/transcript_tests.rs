use super::*;
use std::io::Write;

fn record(text: &str) -> String {
    format!(
        "{}\n",
        serde_json::json!({"type":"user","message":{"content":text}})
    )
}

#[test]
fn oversized_source_retains_recent_complete_records() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    // A sparse old tool record exercises the production byte limit without
    // allocating the entire source in the test or reading its old prefix.
    file.as_file()
        .set_len(MAX_TRANSCRIPT_SOURCE_BYTES + 128)
        .unwrap();
    file.seek(SeekFrom::End(0)).unwrap();
    writeln!(file).unwrap();
    write!(file, "{}{}", record("recent one"), record("recent two")).unwrap();
    let result = transcript_from_file(file.path(), "claude", "test", claude_turn).unwrap();
    assert!(!result.history_complete);
    assert_eq!(
        result
            .entries
            .iter()
            .map(|entry| entry.text.as_str())
            .collect::<Vec<_>>(),
        ["recent one", "recent two"]
    );
}

#[test]
fn suffix_discards_split_utf8_and_keeps_record_on_exact_boundary() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    let latest = record("latest 한글");
    write!(file, "{}{}", record("old 한글"), latest).unwrap();
    for extra in [0, 4] {
        let result = transcript_window(
            file.path(),
            "claude",
            "test",
            claude_turn,
            latest.len() as u64 + extra,
            1024,
            10,
        )
        .unwrap();
        assert!(!result.history_complete);
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].text, "latest 한글");
    }
}

#[test]
fn output_budget_keeps_latest_entries_and_does_not_claim_full_history() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    write!(file, "{}{}{}", record("old"), record("new"), record("last")).unwrap();
    for (bytes, entries) in [(7, 10), (1024, 2)] {
        let result = transcript_window(
            file.path(),
            "claude",
            "test",
            claude_turn,
            1024,
            bytes,
            entries,
        )
        .unwrap();
        assert!(!result.history_complete);
        assert_eq!(
            result
                .entries
                .iter()
                .map(|entry| entry.text.as_str())
                .collect::<Vec<_>>(),
            ["new", "last"]
        );
    }
}

#[test]
fn partial_append_is_incomplete_and_new_prompt_clears_previous_final() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    writeln!(file, "{}", serde_json::json!({"type":"assistant","message":{"content":"done","stop_reason":"end_turn"}})).unwrap();
    let complete = transcript_from_file(file.path(), "claude", "test", claude_turn).unwrap();
    assert!(complete.history_complete);
    assert_eq!(complete.final_response.as_deref(), Some("done"));
    write!(file, "{}{{\"type\":", record("next")).unwrap();
    let partial = transcript_from_file(file.path(), "claude", "test", claude_turn).unwrap();
    assert!(!partial.history_complete);
    assert_eq!(partial.final_response, None);
    assert_eq!(partial.entries.last().unwrap().text, "next");
}

#[test]
fn project_move_claude_reads_exact_history_in_its_selected_account_without_mutation() {
    let root = tempfile::tempdir().unwrap();
    let account = root.path().join("account-a");
    let project = account.join("projects/old-project");
    fs::create_dir_all(&project).unwrap();
    let id = "019f0000-0000-7000-8000-000000000185";
    let history = project.join(format!("{id}.jsonl"));
    let bytes = format!(
        "{{\"type\":\"user\",\"sessionId\":\"{id}\",\"message\":{{\"content\":\"retain me\"}}}}\n"
    );
    fs::write(&history, &bytes).unwrap();
    assert_eq!(
        preflight_project_move_history("claude", Some(account.clone()), id),
        Ok(())
    );
    assert_eq!(fs::read_to_string(&history).unwrap(), bytes);
    assert_eq!(
        preflight_project_move_history("claude", Some(root.path().join("account-b")), id),
        Err("agent_project_move_history_unavailable")
    );
    fs::write(&history, "{\"type\":\"user\",\"sessionId\":\"other\"}\n").unwrap();
    assert_eq!(
        preflight_project_move_history("claude", Some(account), id),
        Err("agent_project_move_history_unavailable")
    );
}

#[test]
fn project_move_claude_refuses_ambiguous_history_and_non_regular_transcripts() {
    let root = tempfile::tempdir().unwrap();
    let id = "019f0000-0000-7000-8000-000000000185";
    for project in ["first", "second"] {
        let directory = root.path().join("projects").join(project);
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join(format!("{id}.jsonl")),
            format!("{{\"type\":\"user\",\"sessionId\":\"{id}\"}}\n"),
        )
        .unwrap();
    }
    assert_eq!(
        preflight_project_move_history("claude", Some(root.path().into()), id),
        Err("agent_project_move_history_ambiguous")
    );
    let second = root.path().join(format!("projects/second/{id}.jsonl"));
    fs::remove_file(&second).unwrap();
    fs::create_dir(second).unwrap();
    assert_eq!(
        preflight_project_move_history("claude", Some(root.path().into()), id),
        Err("agent_project_move_history_unavailable")
    );
}

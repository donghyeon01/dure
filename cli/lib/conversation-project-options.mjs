/** Existing recovery journals retain the source workspace. Never discard a
 * requested destination and submit a same-workspace restart in its place. */
export function assertNoConversationProjectOptions(opts) {
  // The legacy parser leaves --option=value forms in rest; rehost's legacy
  // route must not treat those as ignored extra positionals either.
  const inlineDestination = opts.rest?.some((arg) => /^--(?:project|path|cwd)=/.test(arg));
  if (!opts.projectSpecified && !opts.pathSpecified && !Object.hasOwn(opts, "cwd") && !inlineDestination) return;
  throw Object.assign(new Error(
    "Resume keeps its original workspace and does not accept destination options. No restart was requested. " +
    "To keep this conversation, resume it without --project, --path or --cwd. " +
    "To move an idle or stopped native Claude or Codex conversation on the same backend, " +
    "preview with dure runs move AGENT --project PROJECT --json and use its exact Apply command. " +
    "Claude requires CLI 2.1.223–2.1.284 and exact history; structured project moves remain unsupported. Use dure run --project PROJECT for a new conversation.",
  ), { code: "conversation_project_move_unsupported" });
}

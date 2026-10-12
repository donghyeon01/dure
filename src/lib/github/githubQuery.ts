import { t } from "@/lib/i18n";

export interface GitHubQueryFailure {
	kind:
		| "missing-cli"
		| "timed-out"
		| "project-scope"
		| "command-failed"
		| "invalid-duplicate"
		| "not-repository"
		| "no-remotes"
		| "directory-missing"
		| "malformed-response";
	detail: string;
}

export type GitHubQueryResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: GitHubQueryFailure };

export type GitHubListResult<T> =
	| { ok: true; value: T[]; limitReached: boolean }
	| { ok: false; error: GitHubQueryFailure };

/** Only explicit repository-discovery diagnostics describe an ineligible folder.
 * Unknown/localized output, auth, permission and transport failures stay errors. */
export function githubRepositoryFailure(failure: GitHubQueryFailure): GitHubQueryFailure {
	if (failure.kind !== "command-failed") return failure;
	const detail = failure.detail.trim();
	if (/^failed to run git: fatal: not a git repository\b/.test(detail)) {
		return { ...failure, kind: "not-repository" };
	}
	if (detail === "no git remotes found") return { ...failure, kind: "no-remotes" };
	if (/^resolve login command cwd failed: [^\n]*\(os error 2\)$/.test(detail)) {
		return { ...failure, kind: "directory-missing" };
	}
	return failure;
}

/** Common read failures; operation-specific remedies stay with their caller. */
export function githubQueryFailureMessage(failure: GitHubQueryFailure): string {
	switch (failure.kind) {
		case "missing-cli":
			return t("github.auth.cliMissing");
		case "timed-out":
			return t("github.workspace.error.timedOut");
		case "malformed-response":
			return t("github.workspace.error.malformed");
		case "not-repository":
			return t("github.workspace.discovery.notRepository");
		case "no-remotes":
			return t("github.workspace.discovery.noRemotes");
		case "directory-missing":
			return t("github.workspace.discovery.directoryMissing");
		default:
			return failure.detail || t("github.workspace.error.loadFailed");
	}
}

import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { ErrorText } from "@/components/ui/error-text";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import type { Project } from "@/types";

/** Folder selection only. Registration and launch keep their existing owners. */
export function QuickDispatchFolderDialog({
	initialPath,
	ensureProjectForPath,
	onSelected,
	onClose,
	onReturnFocus,
}: {
	initialPath?: string;
	ensureProjectForPath: (path: string) => Promise<Project>;
	onSelected: (project: Project) => void;
	onClose: () => void;
	onReturnFocus: () => void;
}) {
	const inputId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const [path, setPath] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const operation = useRef<object | null>(null);
	useEffect(
		() => () => {
			operation.current = null;
		},
		[],
	);
	const close = () => {
		operation.current = null;
		onClose();
	};

	const choose = async (browse: boolean) => {
		if (operation.current || (!browse && !path.trim())) return;
		const current = {};
		operation.current = current;
		setBusy(true);
		setError(null);
		try {
			const directory = browse
				? await openFolderDialog({
						directory: true,
						multiple: false,
						defaultPath: initialPath,
						title: t("common.chooseWorkingFolder"),
					})
				: path.trim();
			if (
				operation.current !== current ||
				typeof directory !== "string" ||
				!directory
			)
				return;
			setPath(directory);
			const project = await ensureProjectForPath(directory);
			if (operation.current === current) onSelected(project);
		} catch (cause) {
			if (operation.current === current)
				setError(t("common.folderOpenFailed", { e: String(cause) }));
		} finally {
			if (operation.current === current) {
				operation.current = null;
				setBusy(false);
			}
		}
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<DialogContent
				className="max-h-[calc(100dvh-32px)] w-[min(480px,calc(100vw-32px))] overflow-y-auto bg-glass-pane backdrop-blur-none dark:bg-glass-pane"
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					inputRef.current?.focus();
				}}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					onReturnFocus();
				}}
			>
				<DialogTitle>{t("agents.quickDispatch.chooseFolder")}</DialogTitle>
				<DialogDescription>
					{t("agents.quickDispatch.folderHint")}
				</DialogDescription>
				<form
					className="flex min-w-0 flex-col gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						void choose(false);
					}}
				>
					<label htmlFor={inputId} className="text-xs font-medium">
						{t("agents.quickDispatch.localFolderPath")}
					</label>
					<div className="flex items-center gap-2">
						<Input
							id={inputId}
							ref={inputRef}
							value={path}
							disabled={busy}
							autoComplete="off"
							spellCheck={false}
							aria-invalid={Boolean(error)}
							onChange={(event) => {
								setPath(event.target.value);
								setError(null);
							}}
						/>
						<Button
							type="button"
							variant="outline"
							disabled={busy}
							onClick={() => void choose(true)}
						>
							{t("agents.quickDispatch.browseFolder")}
						</Button>
					</div>
					<ErrorText className="break-words">{error}</ErrorText>
					<div className="flex justify-end gap-2">
						<Button type="button" variant="ghost" onClick={close}>
							{t("common.cancel")}
						</Button>
						<Button type="submit" disabled={busy || !path.trim()}>
							{busy ? t("common.loading") : t("agents.quickDispatch.useFolder")}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

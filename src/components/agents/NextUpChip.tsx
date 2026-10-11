import { Popover } from "radix-ui";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { AgentDiffBadge } from "@/components/agents/AgentDiffBadge";
import { ActivityDot, activityLabel } from "@/components/agents/StatusBits";
import {
	useNextUp,
	useNextUpKeys,
	useNextUpRow,
	useNextUpShortcut,
	useNextUpSpaceNames,
} from "@/components/agents/useNextUp";
import { useNowTick } from "@/components/spaces/useNowTick";
import { Kbd } from "@/components/ui/kbd";
import { Titled } from "@/components/ui/tooltip";
import type { NextUp, NextUpEntry, NextUpReason } from "@/lib/agents/nextUp";
import { revealAgent } from "@/lib/agents/nextUpNavigation";
import type { ProgramStatusNotice } from "@/lib/agents/programStatus";
import { t } from "@/lib/i18n";
import { MENU_GLASS_FILL_CLASS, MENU_SIDE_OFFSET } from "@/lib/ui/menuSurface";
import { keepPointerOpenFocusOnSurface } from "@/lib/ui/pointerOpenFocus";
import { formatRelativeAge } from "@/lib/ui/relativeAge";
import { cn } from "@/lib/utils";
import { isMainWindow } from "@/lib/workspace/window/windows";

const REASON_LABEL: Record<NextUpReason, () => string> = {
	approval: () => activityLabel("blocked"),
	input: () => activityLabel("input"),
	error: () => activityLabel("error"),
	finished: () => t("agents.nextUp.finishedTurn"),
};

const SECTIONS = [
	{ key: "needsYou", heading: () => t("agents.nextUp.needsYou") },
	{ key: "finished", heading: () => t("agents.nextUp.finished") },
] as const;

/** Program text never reads as Dure's: it is always attributed. */
function programMessage({ app, message }: ProgramStatusNotice): string | undefined {
	if (message === undefined) return undefined;
	return app
		? t("agents.nextUp.programMessageFromApp", { app, message })
		: t("agents.nextUp.programMessageFromProgram", { message });
}

/** Which agent needs the person next, across every Space. It belongs to the
 * main window, the one that owns attention notifications: other windows keep
 * their own acknowledgements and observe no Host semantics of their own. */
export function NextUpChip() {
	return isMainWindow() ? <MainWindowNextUp /> : null;
}

/** Draws nothing while nothing is waiting; the attention tone is spent only
 * while a human is blocking work, and finished turns stay quiet. */
function MainWindowNextUp() {
	const nextUp = useNextUp();
	useNextUpShortcut();
	const keys = useNextUpKeys();
	const [open, setOpen] = useState(false);
	// A row hands focus to its pane; returning it to the chip would undo that.
	const selected = useRef(false);
	const needsYou = nextUp.needsYou.length;
	const finished = nextUp.finished.length;
	useEffect(() => {
		if (needsYou + finished === 0) setOpen(false);
	}, [needsYou, finished]);
	if (needsYou + finished === 0) return null;

	const [heading, count] =
		needsYou > 0
			? [t("agents.nextUp.needsYou"), needsYou]
			: [t("agents.nextUp.finished"), finished];
	const select = (agentId: string) => {
		selected.current = true;
		setOpen(false);
		revealAgent(agentId);
	};

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Titled title={t("agents.nextUp.open")}>
				<Popover.Trigger asChild>
					<button
						type="button"
						data-slot="next-up-chip"
						data-tone={needsYou > 0 ? "attention" : "quiet"}
						className={cn(
							"inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-meta leading-none outline-none transition-colors hover:bg-glass-tint-hover focus-visible:ring-1 focus-visible:ring-ring",
							needsYou > 0 ? "text-foreground" : "text-muted-foreground",
						)}
						aria-label={`${t("agents.nextUp.open")} · ${heading} ${count}`}
					>
						<span
							aria-hidden="true"
							className={cn(
								"size-1.5 shrink-0 rounded-full",
								needsYou > 0 ? "bg-status-blocked" : "bg-muted-foreground/60",
							)}
						/>
						{heading}
						<span className="tabular-nums">{count}</span>
					</button>
				</Popover.Trigger>
			</Titled>
			<Popover.Portal>
				<Popover.Content
					data-slot="next-up-list"
					aria-label={t("agents.nextUp.title")}
					side="bottom"
					align="end"
					sideOffset={MENU_SIDE_OFFSET}
					collisionPadding={8}
					onOpenAutoFocus={keepPointerOpenFocusOnSurface}
					onCloseAutoFocus={(event) => {
						if (selected.current) event.preventDefault();
						selected.current = false;
					}}
					// The menu layer's glass, like the usage popover beside it; rows
					// stay text on a readable tint, never over a pane's output.
					className={cn(
						MENU_GLASS_FILL_CLASS,
						"z-50 flex max-h-[min(480px,calc(100vh-64px))] w-80 max-w-[calc(100vw-16px)] origin-(--radix-popover-content-transform-origin) flex-col rounded-lg p-1 text-foreground shadow-menu inset-ring-1 inset-ring-glass-menu-hairline outline-none duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-reduce:animate-none motion-reduce:transform-none motion-reduce:duration-0",
					)}
				>
					<NextUpList nextUp={nextUp} onSelect={select} />
					{keys.length > 0 && (
						<div className="flex shrink-0 items-center justify-between gap-3 border-t border-glass-menu-hairline px-2 pt-2 pb-1 text-meta text-muted-foreground">
							<span className="min-w-0 truncate">
								{t("settings.shortcuts.cmd.goToNextUp")}
							</span>
							<span className="flex shrink-0 items-center gap-0.5">
								{keys.map((key) => (
									<Kbd key={key} size="sm">
										{key}
									</Kbd>
								))}
							</span>
						</div>
					)}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

function NextUpList({
	nextUp,
	onSelect,
}: {
	nextUp: NextUp;
	onSelect: (agentId: string) => void;
}) {
	const now = useNowTick();
	const spaceNames = useNextUpSpaceNames(nextUp);
	return (
		<div className="min-h-0 overflow-y-auto">
			{SECTIONS.map(({ key, heading }) =>
				nextUp[key].length === 0 ? null : (
					<NextUpSection key={key} heading={heading()}>
						{nextUp[key].map((entry) => (
							<NextUpRow
								key={entry.agentId}
								entry={entry}
								now={now}
								spaceName={spaceNames.get(entry.agentId)}
								onSelect={onSelect}
							/>
						))}
					</NextUpSection>
				),
			)}
		</div>
	);
}

function NextUpSection({
	heading,
	children,
}: {
	heading: string;
	children: ReactNode;
}) {
	const headingId = useId();
	return (
		<section aria-labelledby={headingId} className="pb-1">
			<h3
				id={headingId}
				className="flex h-7 items-center px-2 text-meta font-medium text-muted-foreground"
			>
				{heading}
			</h3>
			<ul>{children}</ul>
		</section>
	);
}

function NextUpRow({
	entry,
	now,
	spaceName,
	onSelect,
}: {
	entry: NextUpEntry;
	now: number;
	spaceName: string | undefined;
	onSelect: (agentId: string) => void;
}) {
	const row = useNextUpRow(entry);
	if (!row) return null;
	const meta = [
		REASON_LABEL[entry.reason](),
		entry.sinceMs === undefined ? undefined : formatRelativeAge(entry.sinceMs, now),
		row.projectName,
		spaceName,
	]
		.filter(Boolean)
		.join(" · ");
	const reported = row.programNotice && programMessage(row.programNotice);

	return (
		<li>
			<button
				type="button"
				data-slot="next-up-row"
				className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-glass-tint-hover focus-visible:inset-ring-1 focus-visible:inset-ring-ring"
				onClick={() => onSelect(row.agentId)}
			>
				<span className="flex h-4 shrink-0 items-center">
					<ActivityDot activity={entry.state} unread={entry.reason === "finished"} />
				</span>
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="flex min-w-0 items-center gap-2">
						<span className="min-w-0 flex-1 truncate text-xs leading-4 text-foreground">
							{row.title}
						</span>
						<AgentDiffBadge agentId={row.agentId} />
					</span>
					<span className="truncate text-meta leading-4 text-muted-foreground">
						{meta}
					</span>
					{reported && (
						<span className="line-clamp-2 text-meta leading-4 [overflow-wrap:anywhere] text-muted-foreground">
							{reported}
						</span>
					)}
				</span>
			</button>
		</li>
	);
}

// @vitest-environment jsdom
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localFilePanePath } from "../../../cli/lib/contracts/local-file-pane.mjs";
import { openLocalFilePane } from "@/lib/files/localFilePane";
import { fileDraftKey } from "@/lib/files/fileTarget";
import { openFileViewerOn } from "@/lib/files/fileViewerPane";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import {
	markFilePaneHidden,
	useHiddenFilePanes,
} from "@/lib/workspace/pane/hiddenFilePanesStore";
import { useRecentFileOpens } from "@/lib/files/recentFileOpensStore";
import { useStore } from "@/store";

const disposals: (() => void)[] = [];
function fixture(spaceId = "review"): DockviewApi {
	const element = document.createElement("div");
	document.body.append(element);
	const api = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(1000, 700);
	registerDockview(spaceId, api);
	disposals.push(() => {
		unregisterDockview(spaceId, api);
		api.dispose();
		element.remove();
	});
	return api;
}
beforeEach(() => {
	useStore.setState({
		spaces: [
			{ id: "review", name: "Review" },
			{ id: "other", name: "Other" },
		],
		activeSpaceId: "other",
		fileDrafts: {},
	});
	useHiddenFilePanes.setState({ hidden: {} });
	useRecentFileOpens.setState({ entries: [] });
});
afterEach(() => {
	for (const dispose of disposals.splice(0)) dispose();
});

describe("local file pane transaction", () => {
	it("uses the GUI document identity, preserving the existing pane and draft", async () => {
		const api = fixture();
		const target = {
			source: "local" as const,
			path: "/reports/review notes.md",
		};
		const pane = openFileViewerOn(api, target);
		pane.api.updateParameters({ retainedView: "selection" });
		useStore.setState({
			fileDrafts: { [fileDraftKey(target)]: "unsaved draft" },
		});
		const result = await openLocalFilePane("review", target.path);
		expect(result).toMatchObject({
			panelId: pane.id,
			file: target,
			component: "fileviewer",
			mounted: true,
			reused: true,
		});
		expect(api.panels).toHaveLength(1);
		expect(api.activePanel?.id).toBe(pane.id);
		expect(pane.params?.retainedView).toBe("selection");
		expect(useStore.getState().fileDrafts[fileDraftKey(target)]).toBe(
			"unsaved draft",
		);
		expect(useStore.getState().activeSpaceId).toBe("review");
	});

	it("never substitutes the same path from an SSH pane or another Space", async () => {
		const api = fixture();
		const other = fixture("other");
		const remote = openFileViewerOn(api, {
			source: "ssh",
			hostId: "host",
			path: "/reports/a.md",
		});
		const elsewhere = openFileViewerOn(other, {
			source: "local",
			path: "/reports/a.md",
		});
		const result = await openLocalFilePane("review", "/reports/a.md");
		expect(result.panelId).not.toBe(remote.id);
		expect(result.panelId).not.toBe(elsewhere.id);
		expect(result.file).toEqual({ source: "local", path: "/reports/a.md" });
		expect(api.panels).toHaveLength(2);
		expect(other.panels).toEqual([elsewhere]);
	});

	it("restores a hidden file pane under the original pane ID", async () => {
		const api = fixture();
		markFilePaneHidden("hidden-file", {
			desktopId: "review",
			file: { source: "local", path: "/reports/a.md" },
			anchor: { floating: { x: 20, y: 20, width: 500, height: 400 } },
		});
		const result = await openLocalFilePane("review", "/reports/a.md");
		expect(result.panelId).toBe("hidden-file");
		expect(api.activePanel?.group.api.location.type).toBe("floating");
		expect(useHiddenFilePanes.getState().hidden["hidden-file"]).toBeUndefined();
	});

	it("keeps ordinary HTML in the file viewer and only design mockups in the static preview", async () => {
		const api = fixture();
		const html = await openLocalFilePane("review", "/reports/page.html");
		const mockup = await openLocalFilePane(
			"review",
			"/repo/design/mockups/workspace/Pane/default.html",
		);
		expect(html.component).toBe("fileviewer");
		expect(mockup.component).toBe("mockup");
		expect((await openLocalFilePane("review", mockup.file.path)).panelId).toBe(
			mockup.panelId,
		);
		expect(api.panels).toHaveLength(2);
	});

	it("refuses unknown Spaces and URL coordinates before any layout change", async () => {
		const api = fixture();
		await expect(
			openLocalFilePane("missing", "/reports/a.md"),
		).rejects.toMatchObject({ code: "space_not_found" });
		await expect(
			openLocalFilePane("review", "file:///reports/a.md"),
		).rejects.toMatchObject({ code: "invalid_request" });
		expect(api.panels).toEqual([]);
		expect(useStore.getState().activeSpaceId).toBe("other");
	});
});

it.each([
	"/reports/a b.md",
	"C:\\reports\\a b.html",
	"C:/reports/a.md",
	"\\\\server\\share\\report.md",
])("accepts native absolute coordinates without URL coercion: %s", (path) => {
	expect(localFilePanePath(path, { absolute: true })).toBe(path);
});
it.each([
	"",
	"relative.md",
	"file:///tmp/a.md",
	"https://example.com/a.html",
	"data:text/html,hi",
	"C:relative.md",
	"\0/a.md",
	"/".repeat(4097),
])("rejects invalid app-side coordinates: %s", (path) => {
	expect(() => localFilePanePath(path, { absolute: true })).toThrow();
});

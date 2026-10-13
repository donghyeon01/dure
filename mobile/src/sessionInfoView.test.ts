import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "./i18n";
import { renderSessionInfoSheet } from "./sessionInfoView";

const FACTS = [
  { id: "provider", label: "Provider", value: "claude-code" },
  { id: "session", label: "Session ID", value: "hub-live", code: true },
  { id: "lastError", label: "Last connection error", value: "2 min ago: refused" },
] as const;

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("renderSessionInfoSheet", () => {
  it("draws each fact as a labelled line, identifiers monospaced", () => {
    const host = renderSessionInfoSheet({ title: "claude-2", facts: FACTS }, { dismiss: () => {}, copy: () => {} });
    document.body.append(host);

    expect(host.getAttribute("role")).toBe("dialog");
    expect(host.querySelector(".sheet__title")?.textContent).toBe("claude-2");
    const lines = [...host.querySelectorAll<HTMLElement>(".session-info__fact")];
    expect(lines.map((line) => [line.dataset.fact, line.querySelector("dt")?.textContent, line.querySelector("dd")?.textContent]))
      .toEqual([
        ["provider", "Provider", "claude-code"],
        ["session", "Session ID", "hub-live"],
        ["lastError", "Last connection error", "2 min ago: refused"],
      ]);
    expect(host.querySelector('[data-fact="session"] dd')?.classList.contains("session-info__value--code")).toBe(true);
    expect(host.querySelector('[data-fact="lastError"]')?.classList.contains("session-info__fact--error")).toBe(true);
  });

  it("copies, says so, and closes from its button or the scrim", () => {
    const copy = vi.fn();
    const dismiss = vi.fn();
    const host = renderSessionInfoSheet({ title: "claude-2", facts: FACTS }, { dismiss, copy });
    document.body.append(host);

    const [copyButton, closeButton] = host.querySelectorAll<HTMLButtonElement>("button");
    expect(copyButton.textContent).toBe(t("sessionInfo.copy"));
    copyButton.click();
    expect(copy).toHaveBeenCalledOnce();
    closeButton.click();
    host.click();
    expect(dismiss).toHaveBeenCalledTimes(2);

    const copied = renderSessionInfoSheet({ title: "claude-2", facts: FACTS, copied: true }, { dismiss, copy });
    expect(copied.querySelector(".session-info__copy")?.textContent).toBe(t("복사됨"));
  });
});

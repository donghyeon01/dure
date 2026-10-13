/**
 * The sheet a row menu's 세션 정보 opens: who the session is on the computer, and
 * why the phone last failed to reach it. The lines are `sessionInfo.ts`; this
 * file only draws them.
 *
 * A sheet rather than a screen, like the source-control sheets: the list stays
 * visible behind it, and that list is where the person goes next.
 *
 * The values are selectable text as well as one copy button. The button is the
 * way that always pastes the whole set; selection is what still works when the
 * clipboard refuses, and the toast then says so.
 */

import { element, sheetShell } from "./dom";
import { t } from "./i18n";
import type { SessionInfoFact } from "./sessionInfo";
import "./sessionInfoView.css";

export interface SessionInfoSheetModel {
  readonly title: string;
  readonly facts: readonly SessionInfoFact[];
  /** The copy button has just put the lines on the clipboard. */
  readonly copied?: boolean;
}

export interface SessionInfoSheetActions {
  readonly dismiss: () => void;
  readonly copy: () => void;
}

export function renderSessionInfoSheet(
  model: SessionInfoSheetModel,
  actions: SessionInfoSheetActions,
): HTMLElement {
  const { host, panel } = sheetShell(model.title, actions.dismiss, "sheet--tray session-info");
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-modal", "true");
  host.setAttribute("aria-label", t("sessionInfo.sheetLabel", { title: model.title }));

  const list = element("dl", "session-info__facts");
  for (const fact of model.facts) {
    const line = element("div", "session-info__fact");
    line.dataset.fact = fact.id;
    if (fact.id === "lastError") line.classList.add("session-info__fact--error");
    line.append(
      element("dt", "session-info__label", fact.label),
      element("dd", fact.code ? "session-info__value session-info__value--code" : "session-info__value", fact.value),
    );
    list.append(line);
  }
  panel.append(list);

  const copy = element(
    "button",
    "pair-button pair-button--solid pair-button--block session-info__copy",
    model.copied ? t("복사됨") : t("sessionInfo.copy"),
  );
  copy.type = "button";
  copy.addEventListener("click", actions.copy);
  const close = element("button", "pair-button pair-button--ghost pair-button--block", t("common.close"));
  close.type = "button";
  close.addEventListener("click", actions.dismiss);
  panel.append(copy, close);
  return host;
}

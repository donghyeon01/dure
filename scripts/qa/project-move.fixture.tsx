import { createRoot } from "react-dom/client";
import { AgentProjectMove } from "@/components/agents/AgentProjectMove";
import { setLang } from "@/lib/i18n";
import { evidence } from "./project-move.fixture-actions";
import "@/index.css";

setLang("en");
Object.assign(window, { projectMoveEvidence: evidence });
const before = new URLSearchParams(location.search).has("before");
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-3xl p-6 text-foreground">
    <div className="flex items-center justify-between border-b pb-3">
      <h1 className="text-sm font-medium">Conversation · Original project</h1>
      {!before && <AgentProjectMove agentId="fixture-agent" />}
    </div>
    <p className="mt-8 text-sm text-muted-foreground">Existing conversation history remains available.</p>
  </main>,
);

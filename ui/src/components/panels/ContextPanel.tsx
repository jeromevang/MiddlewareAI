import { useState } from "react";
import clsx from "clsx";
import { useDashboardStore } from "../../state/dashboard-store";
import { Card } from "../ui/Card";

interface ContextPanelProps {
  className?: string;
}

const tabs = ["Context", "RAG", "Compression"] as const;

type Tab = (typeof tabs)[number];

export default function ContextPanel({ className }: ContextPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>("Context");
  const metrics = useDashboardStore((s) => s.metrics);
  const status = useDashboardStore((s) => s.status);

  const contextText = metrics?.lastContextText ?? status?.context_snapshot?.preview ?? "No context yet.";
  const ragItems = metrics?.lastRagResults ?? status?.context_snapshot?.rag ?? [];
  const budget = metrics?.lastBudget ?? status?.context;

  return (
    <Card title="Context Assembly" subtitle="Budget" className={clsx("space-y-4", className)}>
      <div className="flex gap-2 rounded-2xl bg-night-900/70 p-1 text-sm">
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={clsx(
              "flex-1 rounded-2xl px-3 py-1.5 font-semibold transition",
              activeTab === tab ? "bg-night-800 text-white" : "text-slate-400 hover:text-slate-200"
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "Context" && (
        <div className="space-y-2 text-sm text-slate-200">
          <p className="text-xs uppercase tracking-[0.3em] text-slate-500">Prompt Snapshot</p>
          <div className="max-h-64 overflow-auto rounded-2xl border border-night-800/80 bg-night-900/50 p-4 font-mono text-xs leading-relaxed text-slate-300">
            {contextText || "No prompt composed yet."}
          </div>
        </div>
      )}

      {activeTab === "RAG" && (
        <div className="space-y-3 text-sm">
          {ragItems.length === 0 && <p className="text-slate-400">No retrieved chunks yet.</p>}
          {ragItems.map((item, idx) => (
            <div key={`${item.filePath}-${idx}`} className="rounded-2xl border border-night-800/70 bg-night-900/60 p-3">
              <p className="text-xs text-slate-400">{item.filePath}</p>
              <p className="text-slate-100">{item.summaryText || "—"}</p>
              {item.distance !== undefined && (
                <p className="text-[10px] text-slate-500 mt-1">distance {item.distance.toFixed(4)}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {activeTab === "Compression" && budget && (
        <div className="space-y-4">
          <div className="flex items-center justify-between text-sm">
            <p>Budget usage</p>
            <p className="font-semibold">
              {budget.usedTokens ?? 0}/{budget.budgetTokens ?? 0} tokens
            </p>
          </div>
          <div className="h-3 w-full rounded-full bg-night-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-accent-secondary to-accent-primary"
              style={{ width: `${Math.min(100, ((budget.usedTokens ?? 0) / (budget.budgetTokens ?? 1)) * 100)}%` }}
            />
          </div>
          <ul className="text-sm text-slate-400 space-y-1">
            <li>
              Summary trimmed: <strong>{budget.trimmedSummaryTokens ?? 0}</strong>
            </li>
            <li>
              RAG trimmed: <strong>{budget.trimmedContextTokens ?? 0}</strong>
            </li>
          </ul>
        </div>
      )}
    </Card>
  );
}

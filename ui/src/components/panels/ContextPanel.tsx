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
      <div className="flex gap-2 rounded-2xl bg-white/5 p-1 text-sm">
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={clsx(
              "flex-1 rounded-2xl px-3 py-1.5 font-semibold transition",
              activeTab === tab ? "bg-white/20 text-white" : "text-white/60 hover:text-white"
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "Context" && (
        <div className="space-y-2 text-sm text-white/80">
          <p className="text-xs uppercase tracking-[0.3em] text-white/50">Prompt Snapshot</p>
          <div className="max-h-64 overflow-auto rounded-2xl border border-white/10 bg-white/5 p-4 font-mono text-xs leading-relaxed text-white/80">
            {contextText || "No prompt composed yet."}
          </div>
        </div>
      )}

      {activeTab === "RAG" && (
        <div className="space-y-3 text-sm">
          {ragItems.length === 0 && <p className="text-white/60">No retrieved chunks yet.</p>}
          {ragItems.map((item, idx) => (
            <div key={`${item.filePath}-${idx}`} className="rounded-2xl border border-white/10 bg-white/5 p-3">
              <p className="text-xs text-white/60">{item.filePath}</p>
              <p className="text-white">{item.summaryText || "—"}</p>
              {item.distance !== undefined && (
                <p className="text-[10px] text-white/50 mt-1">distance {item.distance.toFixed(4)}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {activeTab === "Compression" && budget && (
        <div className="space-y-4">
          <div className="flex items-center justify-between text-sm text-white/80">
            <p>Budget usage</p>
            <p className="font-semibold">
              {budget.usedTokens ?? 0}/{budget.budgetTokens ?? 0} tokens
            </p>
          </div>
          <div className="h-3 w-full rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#2CD4FA] to-[#8D54FF]"
              style={{ width: `${Math.min(100, ((budget.usedTokens ?? 0) / (budget.budgetTokens ?? 1)) * 100)}%` }}
            />
          </div>
          <ul className="text-sm text-white/70 space-y-1">
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

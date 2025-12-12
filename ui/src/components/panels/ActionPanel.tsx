import { useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { triggerAction } from "../../lib/api";
import { useDashboardStore } from "../../state/dashboard-store";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { RefreshCcw, RotateCcw, Power } from "lucide-react";

type ActionKey = "reindex" | "reset" | "lmstudio/restart";

const ACTION_CONFIG: Array<{
  key: ActionKey;
  label: string;
  description: string;
  icon: typeof RefreshCcw;
  variant?: "primary" | "secondary" | "danger";
}> = [
  {
    key: "reindex",
    label: "Reindex files",
    description: "Rebuild the FAISS index and refresh cached summaries.",
    icon: RefreshCcw,
  },
  {
    key: "reset",
    label: "Reset caches",
    description: "Clear SQLite + FAISS, then trigger a background reindex run.",
    icon: RotateCcw,
    variant: "secondary",
  },
  {
    key: "lmstudio/restart",
    label: "Restart LM Studio",
    description: "Request the LM Studio CLI to restart and reload configured models.",
    icon: Power,
    variant: "secondary",
  },
];

export default function ActionPanel() {
  const indexing = useDashboardStore((s) => s.status?.indexingInProgress ?? false);
  const mutation = useMutation<void, Error, ActionKey>({
    mutationFn: (verb) => triggerAction(verb),
  });

  const lastContext = useDashboardStore((s) => s.metrics?.lastContextTs ?? null);
  const contextLabel = useMemo(() => {
    if (!lastContext) return "No recent /query";
    return new Date(lastContext).toLocaleTimeString();
  }, [lastContext]);

  const runAction = (key: ActionKey) => {
    mutation.mutate(key);
  };

  return (
    <Card title="Action Center" subtitle={`Last context refresh: ${contextLabel}`}>
      <div className="grid gap-4 md:grid-cols-3">
        {ACTION_CONFIG.map(({ key, label, description, icon: Icon, variant }) => (
          <div key={key} className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
            <div className="flex items-center gap-3">
              <div className="rounded-2xl bg-white/10 p-2 text-accent-secondary">
                <Icon className="h-5 w-5" />
              </div>
              <div>
                <p className="font-semibold text-white">{label}</p>
                <p className="text-xs text-white/70">{description}</p>
              </div>
            </div>
            <Button
              variant={variant || "primary"}
              onClick={() => runAction(key)}
              loading={mutation.isPending && mutation.variables === key}
              disabled={(key === "reindex" && indexing) || mutation.isPending}
            >
              {key === "reindex" && indexing ? "Indexer running" : "Execute"}
            </Button>
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-white/60">
        These actions call the middleware endpoints directly. Double-check LM Studio status and API key auth before issuing
        destructive operations.
      </p>
    </Card>
  );
}

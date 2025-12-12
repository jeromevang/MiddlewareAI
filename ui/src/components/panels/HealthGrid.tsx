import { Activity, Database, HardDriveDownload, ShieldCheck } from "lucide-react";
import { useDashboardStore } from "../../state/dashboard-store";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";

export default function HealthGrid() {
  const status = useDashboardStore((s) => s.status);
  const metrics = useDashboardStore((s) => s.metrics);

  const cards = [
    {
      title: "Middleware",
      subtitle: "Server",
      icon: <ShieldCheck className="h-5 w-5" />,
      value: `Port ${status?.server.port ?? 0}`,
      healthy: true,
      detail: status?.runtime.mode === "cloud" ? "Cloud mode" : "Local mode",
    },
    {
      title: "LM Studio",
      subtitle: "Generation",
      icon: <Activity className="h-5 w-5" />,
      value: status?.lmstudio.healthy ? "Online" : "Offline",
      healthy: Boolean(status?.lmstudio.healthy),
      detail: status?.lmstudio.url || "not configured",
    },
    {
      title: "Indexer",
      subtitle: "RAG",
      icon: <HardDriveDownload className="h-5 w-5" />,
      value: status?.indexingInProgress ? "Running" : "Idle",
      healthy: !status?.indexingInProgress,
      detail: `${status?.processing.max_chunk_size ?? 0} lines / chunk`,
    },
    {
      title: "Vectors",
      subtitle: "FAISS",
      icon: <Database className="h-5 w-5" />,
      value: `${status?.storage.faiss_entries ?? 0} entries`,
      healthy: true,
      detail: `${status?.storage.faiss_dim ?? 0} dims · ${metrics?.totalRequests ?? 0} req`,
    },
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-4 md:grid-cols-2">
      {cards.map((card) => (
        <Card
          key={card.title}
          className="relative overflow-hidden"
          subtitle={card.subtitle}
          title={card.title}
          action={<Badge tone={card.healthy ? "positive" : "danger"}>{card.healthy ? "Healthy" : "Check"}</Badge>}
        >
          <div className="flex items-center gap-4">
            <div className="rounded-2xl bg-night-800 p-3 text-accent-secondary">{card.icon}</div>
            <div>
              <p className="text-2xl font-semibold text-white">{card.value}</p>
              <p className="text-sm text-slate-400">{card.detail}</p>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

/**
 * ResourceBars - Real-time CPU/RAM/VRAM usage visualization
 */

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";

interface ResourceData {
  cpu: {
    usagePercent: number;
    cores: number;
  };
  ram: {
    totalGB: number;
    usedGB: number;
    freeGB: number;
    usagePercent: number;
  };
  vram: {
    name: string;
    totalGB: number;
    usedGB: number;
    freeGB: number;
    usagePercent: number;
  } | null;
}

async function fetchRealtimeResources(): Promise<ResourceData> {
  const res = await fetch("/hardware/realtime");
  if (!res.ok) throw new Error("Failed to fetch resources");
  const data = await res.json();
  return data;
}

interface ProgressBarProps {
  label: string;
  icon: string;
  usedGB?: number;
  totalGB?: number;
  usagePercent: number;
  color: "green" | "blue" | "purple";
}

function ProgressBar({
  label,
  icon,
  usedGB,
  totalGB,
  usagePercent,
  color,
}: ProgressBarProps) {
  const getBarColor = (percent: number) => {
    if (percent >= 90) return "bg-red-500";
    if (percent >= 75) return "bg-amber-500";
    return color === "green"
      ? "bg-emerald-500"
      : color === "blue"
      ? "bg-blue-500"
      : "bg-purple-500";
  };

  const getStatusLabel = (percent: number) => {
    if (percent >= 90) return "Critical";
    if (percent >= 75) return "High";
    if (percent >= 50) return "Moderate";
    return "Good";
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5 text-white/70">
          <span>{icon}</span>
          <span>{label}</span>
        </div>
        <div className="flex items-center gap-2">
          {usedGB !== undefined && totalGB !== undefined ? (
            <span className="text-white/50">
              {usedGB.toFixed(1)} / {totalGB.toFixed(1)} GB
            </span>
          ) : (
            <span className="text-white/50">{usagePercent.toFixed(1)}%</span>
          )}
          <span
            className={clsx(
              "px-1.5 py-0.5 rounded text-[10px] font-medium",
              usagePercent >= 90
                ? "bg-red-500/20 text-red-400"
                : usagePercent >= 75
                ? "bg-amber-500/20 text-amber-400"
                : "bg-emerald-500/20 text-emerald-400"
            )}
          >
            {getStatusLabel(usagePercent)}
          </span>
        </div>
      </div>
      <div className="h-2 bg-white/5 rounded-full overflow-hidden">
        <div
          className={clsx("h-full transition-all duration-500 rounded-full", getBarColor(usagePercent))}
          style={{ width: `${Math.min(100, usagePercent)}%` }}
        />
      </div>
    </div>
  );
}

interface ResourceBarsProps {
  className?: string;
  pollInterval?: number;
}

export function ResourceBars({
  className,
  pollInterval = 3000,
}: ResourceBarsProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["hardware-realtime"],
    queryFn: fetchRealtimeResources,
    refetchInterval: pollInterval,
    staleTime: pollInterval - 500,
  });

  if (isLoading) {
    return (
      <div className={clsx("space-y-3 animate-pulse", className)}>
        <div className="h-6 bg-white/5 rounded" />
        <div className="h-6 bg-white/5 rounded" />
        <div className="h-6 bg-white/5 rounded" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className={clsx("text-xs text-white/40 italic", className)}>
        Resource monitoring unavailable
      </div>
    );
  }

  return (
    <div className={clsx("space-y-3", className)}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-white/60">
          System Resources
        </span>
        <span className="text-[10px] text-white/40">Live</span>
      </div>

      {/* Hardware Detection Info */}
      {data.vram && (
        <div className="text-xs text-white/70 bg-white/5 rounded px-3 py-2 border border-white/10">
          <div className="font-medium text-white mb-1">Detected Hardware</div>
          <div className="flex items-center gap-2">
            <span className="text-emerald-400">🎮</span>
            <span>{data.vram.name}</span>
            <span className="text-white/50">•</span>
            <span>{data.vram.totalGB} GB VRAM</span>
          </div>
        </div>
      )}

      <ProgressBar
        label="CPU"
        icon="⚡"
        usagePercent={data.cpu.usagePercent}
        color="blue"
      />

      <ProgressBar
        label="RAM"
        icon="💾"
        usedGB={data.ram.usedGB}
        totalGB={data.ram.totalGB}
        usagePercent={data.ram.usagePercent}
        color="purple"
      />

      {data.vram && (
        <ProgressBar
          label="VRAM"
          icon="🎮"
          usedGB={data.vram.usedGB}
          totalGB={data.vram.totalGB}
          usagePercent={data.vram.usagePercent}
          color="green"
        />
      )}
    </div>
  );
}

export default ResourceBars;


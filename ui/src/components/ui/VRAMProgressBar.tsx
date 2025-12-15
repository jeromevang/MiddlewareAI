import clsx from "clsx";

interface VRAMProgressBarProps {
  usedGB: number;
  totalGB: number;
  breakdown?: {
    main?: number;
    summarizer?: number;
    embedder?: number;
  };
  showLabels?: boolean;
  showBreakdown?: boolean;
  className?: string;
}

type VRAMStatus = "good" | "warning" | "overflow";

function getStatus(percentage: number): VRAMStatus {
  if (percentage <= 80) return "good";
  if (percentage <= 100) return "warning";
  return "overflow";
}

const statusColors: Record<VRAMStatus, string> = {
  good: "bg-accent-success",
  warning: "bg-amber-500",
  overflow: "bg-accent-danger",
};

const statusBgColors: Record<VRAMStatus, string> = {
  good: "bg-accent-success/20",
  warning: "bg-amber-500/20",
  overflow: "bg-accent-danger/20",
};

const statusTextColors: Record<VRAMStatus, string> = {
  good: "text-accent-success",
  warning: "text-amber-400",
  overflow: "text-accent-danger",
};

/**
 * VRAM Progress Bar with overflow visualization
 * 
 * Shows estimated VRAM usage vs available VRAM:
 * - Green (<80%): Comfortable headroom
 * - Yellow (80-100%): Tight but fits
 * - Red (>100%): Overflow - won't fit
 * 
 * Overflow extends visually past the bar boundary
 */
export function VRAMProgressBar({
  usedGB,
  totalGB,
  breakdown,
  showLabels = true,
  showBreakdown = false,
  className,
}: VRAMProgressBarProps) {
  const percentage = totalGB > 0 ? (usedGB / totalGB) * 100 : 0;
  const status = getStatus(percentage);
  const overflow = Math.max(0, usedGB - totalGB);
  const isOverflow = overflow > 0;
  
  // Cap the visual bar at 150% for extreme overflow cases
  const visualPercentage = Math.min(percentage, 150);
  const basePercentage = Math.min(percentage, 100);
  const overflowPercentage = Math.max(0, visualPercentage - 100);

  return (
    <div className={clsx("space-y-2", className)}>
      {/* Header with usage info */}
      {showLabels && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-white/70 font-medium">VRAM Usage</span>
          <div className="flex items-center gap-2">
            <span className={clsx("font-mono", statusTextColors[status])}>
              {usedGB.toFixed(1)} / {totalGB.toFixed(1)} GB
            </span>
            <StatusBadge status={status} />
          </div>
        </div>
      )}

      {/* Progress bar container */}
      <div className="relative">
        {/* Background track */}
        <div className="h-4 rounded-full bg-white/10 border border-white/20 overflow-visible relative">
          {/* Filled portion (up to 100%) */}
          <div
            className={clsx(
              "absolute top-0 left-0 h-full rounded-l-full transition-all duration-300",
              isOverflow ? "rounded-r-none" : "rounded-r-full",
              statusColors[status]
            )}
            style={{ width: `${basePercentage}%` }}
          />
          
          {/* Overflow portion (beyond 100%) */}
          {isOverflow && (
            <div
              className={clsx(
                "absolute top-0 h-full rounded-r-full transition-all duration-300",
                "bg-accent-danger animate-pulse",
                "border-l-2 border-white/30"
              )}
              style={{
                left: "100%",
                width: `${overflowPercentage}%`,
              }}
            />
          )}
          
          {/* 100% marker line */}
          {isOverflow && (
            <div className="absolute top-0 right-0 h-full w-0.5 bg-white/40" />
          )}
        </div>
        
        {/* Percentage label positioned at the end of the bar */}
        <div
          className={clsx(
            "absolute top-1/2 -translate-y-1/2 text-xs font-semibold px-1",
            statusTextColors[status]
          )}
          style={{
            left: `${Math.min(visualPercentage, 95)}%`,
            transform: "translate(-50%, -50%)",
          }}
        >
          {Math.round(percentage)}%
        </div>
      </div>

      {/* Breakdown by role */}
      {showBreakdown && breakdown && (
        <div className="flex items-center gap-4 text-xs">
          {breakdown.main !== undefined && breakdown.main > 0 && (
            <BreakdownItem label="Main" value={breakdown.main} color="bg-blue-500" />
          )}
          {breakdown.summarizer !== undefined && breakdown.summarizer > 0 && (
            <BreakdownItem label="Sum" value={breakdown.summarizer} color="bg-purple-500" />
          )}
          {breakdown.embedder !== undefined && breakdown.embedder > 0 && (
            <BreakdownItem label="Emb" value={breakdown.embedder} color="bg-green-500" />
          )}
        </div>
      )}

      {/* Warning message for overflow */}
      {isOverflow && (
        <div className="flex items-center gap-2 text-xs text-accent-danger">
          <WarningIcon className="w-4 h-4" />
          <span>
            Configuration exceeds VRAM by {overflow.toFixed(1)} GB. 
            Consider using smaller models.
          </span>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: VRAMStatus }) {
  const labels: Record<VRAMStatus, string> = {
    good: "Fits",
    warning: "Tight",
    overflow: "Overflow",
  };

  return (
    <span
      className={clsx(
        "px-2 py-0.5 rounded-full text-xs font-semibold",
        statusBgColors[status],
        statusTextColors[status]
      )}
    >
      {labels[status]}
    </span>
  );
}

function BreakdownItem({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-1.5 text-white/60">
      <div className={clsx("w-2 h-2 rounded-full", color)} />
      <span>{label}:</span>
      <span className="text-white/80 font-mono">{value.toFixed(1)}GB</span>
    </div>
  );
}

function WarningIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path
        fillRule="evenodd"
        d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/**
 * Compact VRAM indicator for smaller spaces
 */
export function VRAMIndicator({
  usedGB,
  totalGB,
  className,
}: {
  usedGB: number;
  totalGB: number;
  className?: string;
}) {
  const percentage = totalGB > 0 ? (usedGB / totalGB) * 100 : 0;
  const status = getStatus(percentage);

  return (
    <div className={clsx("flex items-center gap-2", className)}>
      <div className="w-20 h-2 rounded-full bg-white/10 overflow-hidden">
        <div
          className={clsx("h-full rounded-full", statusColors[status])}
          style={{ width: `${Math.min(percentage, 100)}%` }}
        />
      </div>
      <span className={clsx("text-xs font-mono", statusTextColors[status])}>
        {usedGB.toFixed(1)}GB
      </span>
    </div>
  );
}


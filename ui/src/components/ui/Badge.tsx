import type { HTMLAttributes } from "react";
import clsx from "clsx";

type BadgeTone = "neutral" | "positive" | "warn" | "danger" | "info";

const toneStyles: Record<BadgeTone, string> = {
  neutral: "bg-white/20 text-white border border-white/30",
  positive: "bg-accent-success/20 text-accent-success border border-accent-success/40",
  warn: "bg-accent-warning/20 text-accent-warning border border-accent-warning/40",
  danger: "bg-accent-danger/20 text-accent-danger border border-accent-danger/40",
  info: "bg-accent-secondary/15 text-accent-secondary border border-accent-secondary/40",
};

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wider",
        toneStyles[tone],
        className
      )}
      {...props}
    />
  );
}

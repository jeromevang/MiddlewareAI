import clsx from "clsx";

interface LockButtonProps {
  locked: boolean;
  onToggle: () => void;
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  tooltip?: string;
  className?: string;
}

const sizeStyles = {
  sm: "w-6 h-6 p-1",
  md: "w-8 h-8 p-1.5",
  lg: "w-10 h-10 p-2",
};

const iconSizes = {
  sm: "w-4 h-4",
  md: "w-5 h-5",
  lg: "w-6 h-6",
};

/**
 * Lock button component for toggling model lock state
 * 
 * Lock states:
 * - Unlocked: Outline lock icon - Model can be changed/unloaded freely
 * - Locked: Filled lock icon - Model is protected from automatic changes
 */
export function LockButton({
  locked,
  onToggle,
  size = "md",
  disabled = false,
  tooltip,
  className,
}: LockButtonProps) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      title={tooltip || (locked ? "Click to unlock" : "Click to lock")}
      className={clsx(
        "flex items-center justify-center rounded-lg transition-all duration-200",
        "focus:outline-none focus:ring-2 focus:ring-accent-primary/50",
        sizeStyles[size],
        locked
          ? "bg-amber-500/20 text-amber-400 border border-amber-400/40 hover:bg-amber-500/30"
          : "bg-white/5 text-white/40 border border-white/10 hover:bg-white/10 hover:text-white/60",
        disabled && "opacity-50 cursor-not-allowed",
        className
      )}
    >
      {locked ? (
        <LockClosedIcon className={iconSizes[size]} />
      ) : (
        <LockOpenIcon className={iconSizes[size]} />
      )}
    </button>
  );
}

function LockClosedIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        fillRule="evenodd"
        d="M12 1.5a5.25 5.25 0 00-5.25 5.25v3a3 3 0 00-3 3v6.75a3 3 0 003 3h10.5a3 3 0 003-3v-6.75a3 3 0 00-3-3v-3c0-2.9-2.35-5.25-5.25-5.25zm3.75 8.25v-3a3.75 3.75 0 10-7.5 0v3h7.5z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function LockOpenIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13.5 10.5V6.75a4.5 4.5 0 119 0v3.75M3.75 21.75h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
      />
    </svg>
  );
}

/**
 * Compact lock indicator (non-interactive)
 */
export function LockIndicator({
  locked,
  size = "sm",
  className,
}: {
  locked: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  if (!locked) return null;

  return (
    <span
      className={clsx(
        "inline-flex items-center justify-center text-amber-400",
        iconSizes[size],
        className
      )}
      title="Model is locked"
    >
      <LockClosedIcon className="w-full h-full" />
    </span>
  );
}


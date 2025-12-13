import type { ButtonHTMLAttributes } from "react";
import clsx from "clsx";

interface ToggleSwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  loading?: boolean;
  label?: string;
}

export function ToggleSwitch({
  checked,
  onCheckedChange,
  disabled,
  loading,
  className,
  label,
  ...props
}: ToggleSwitchProps) {
  const isDisabled = disabled || loading;
  const handleClick = () => {
    if (isDisabled) return;
    onCheckedChange?.(!checked);
  };

  return (
    <button
      type="button"
      className={clsx(
        "flex items-center gap-3 rounded-full border border-white/15 bg-night-900/60 px-4 py-2 text-sm font-semibold transition",
        checked ? "ring-2 ring-emerald-400/60" : "hover:border-white/40",
        isDisabled && "opacity-60 cursor-not-allowed",
        className
      )}
      onClick={handleClick}
      aria-pressed={checked}
      {...props}
    >
      <span
        className={clsx(
          "relative inline-flex h-5 w-10 items-center rounded-full border border-white/20 bg-white/10 transition",
          checked && "bg-emerald-400/30 border-emerald-300/60"
        )}
      >
        <span
          className={clsx(
            "h-4 w-4 rounded-full bg-white shadow transition",
            checked ? "translate-x-5 bg-emerald-300" : "translate-x-1"
          )}
        />
      </span>
      <span className="flex items-center gap-1 text-white/80">
        <span
          className={clsx(
            "inline-block h-2 w-2 rounded-full",
            checked ? "bg-emerald-400 shadow-glow" : "bg-white/30"
          )}
        />
        {label ?? (checked ? "Enabled" : "Disabled")}
      </span>
    </button>
  );
}

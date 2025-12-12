import type { ButtonHTMLAttributes, ReactNode } from "react";
import clsx from "clsx";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  icon?: ReactNode;
  loading?: boolean;
};

const VARIANT_STYLES: Record<ButtonVariant, string> = {
  primary:
    "bg-gradient-to-r from-accent-primary to-accent-secondary text-night-950 shadow-glow hover:opacity-90",
  secondary: "bg-night-800 text-slate-50 border border-slate-700 hover:border-accent-secondary/60",
  ghost: "bg-transparent text-slate-200 hover:bg-night-800/80 border border-transparent",
  danger: "bg-accent-danger text-white hover:bg-accent-danger/90",
};

export function Button({
  className,
  variant = "primary",
  icon,
  children,
  loading,
  disabled,
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading;
  return (
    <button
      className={clsx(
        "inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-accent-secondary",
        VARIANT_STYLES[variant],
        isDisabled && "opacity-60 cursor-not-allowed",
        className
      )}
      disabled={isDisabled}
      {...props}
    >
      {loading && <span className="w-2 h-2 rounded-full bg-current animate-pulse" />}
      {icon}
      {children}
    </button>
  );
}

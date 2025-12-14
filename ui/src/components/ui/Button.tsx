import type { ButtonHTMLAttributes, ReactNode } from "react";
import clsx from "clsx";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success" | "warning";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  icon?: ReactNode;
  loading?: boolean;
  size?: "sm" | "md" | "lg";
};

const VARIANT_STYLES: Record<ButtonVariant, string> = {
  primary:
    "bg-gradient-to-r from-accent-primary via-[#A463FF] to-accent-secondary text-white shadow-glow hover:opacity-90",
  secondary: "bg-night-800/80 text-white border border-white/20 hover:border-white/40 hover:bg-night-700/80",
  ghost: "bg-white/10 text-white/80 hover:bg-white/20 border border-white/10",
  danger: "bg-accent-danger text-white hover:bg-accent-danger/90",
  success: "bg-accent-success text-white hover:bg-accent-success/90",
  warning: "bg-accent-warning text-white hover:bg-accent-warning/90",
};

const SIZE_STYLES = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
  lg: "px-6 py-3 text-base",
};

export function Button({
  className,
  variant = "primary",
  icon,
  children,
  loading,
  disabled,
  size = "md",
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading;
  return (
    <button
      className={clsx(
        "inline-flex items-center gap-2 rounded-lg font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-accent-secondary",
        VARIANT_STYLES[variant],
        SIZE_STYLES[size],
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

import type { HTMLAttributes, ReactNode } from "react";
import clsx from "clsx";

interface CardProps extends HTMLAttributes<HTMLElement> {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Card({ title, subtitle, action, children, className, ...rest }: CardProps) {
  return (
    <section className={clsx("glass-card p-5 lg:p-6 space-y-4", className)} {...rest}>
      {(title || subtitle || action) && (
        <div className="flex items-start justify-between gap-4">
          <div>
            {subtitle && <p className="stat-label mb-1">{subtitle}</p>}
            {title && <h2 className="text-lg font-semibold text-white">{title}</h2>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      <div>{children}</div>
    </section>
  );
}

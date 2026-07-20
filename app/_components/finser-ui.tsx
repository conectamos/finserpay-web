import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function AppShell({
  sidebar,
  children,
  className,
}: {
  sidebar?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={classes("fp-ui-shell", Boolean(sidebar) && "has-sidebar", className)}>
      {sidebar}
      <div className="fp-ui-main">{children}</div>
    </div>
  );
}

export function Sidebar({
  children,
  className,
}: HTMLAttributes<HTMLElement>) {
  return <aside className={classes("fp-ui-sidebar", className)}>{children}</aside>;
}

export function Topbar({ children, className }: HTMLAttributes<HTMLElement>) {
  return <header className={classes("fp-ui-topbar", className)}>{children}</header>;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={classes("fp-ui-page-header", className)}>
      <div>
        {eyebrow ? <div className="fp-ui-eyebrow">{eyebrow}</div> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="fp-ui-page-actions">{actions}</div> : null}
    </header>
  );
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={classes("fp-ui-card", className)} {...props} />;
}

export function Button({
  variant = "primary",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button
      type={type}
      className={classes("fp-ui-button", `is-${variant}`, className)}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={classes("fp-ui-input", className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={classes("fp-ui-input", className)} {...props} />;
}

export function Tabs({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={classes("fp-ui-tabs", className)} role="tablist" {...props}>
      {children}
    </div>
  );
}

export function Badge({
  tone = "neutral",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: "neutral" | "positive" | "warning" | "danger";
}) {
  return <span className={classes("fp-ui-badge", `is-${tone}`, className)} {...props} />;
}

export function StatusPill({
  tone = "neutral",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: "neutral" | "positive" | "warning" | "danger";
}) {
  return <span className={classes("fp-ui-status", `is-${tone}`, className)} {...props} />;
}

export function MetricCard({
  label,
  value,
  detail,
  children,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={classes("fp-ui-metric", className)}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
      {children}
    </Card>
  );
}

export function ProgressBar({
  value,
  label,
  className,
}: {
  value: number;
  label?: string;
  className?: string;
}) {
  const normalized = Math.min(100, Math.max(0, Number(value || 0)));

  return (
    <div
      className={classes("fp-ui-progress", className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(normalized)}
    >
      <span style={{ width: `${normalized}%` }} />
    </div>
  );
}

export function DataTable({ children, className }: HTMLAttributes<HTMLDivElement>) {
  return <div className={classes("fp-ui-table", className)}>{children}</div>;
}

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={classes("fp-ui-empty", className)}>
      <strong>{title}</strong>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}

export function LoadingState({ label = "Cargando..." }: { label?: string }) {
  return (
    <div className="fp-ui-loading" role="status" aria-live="polite">
      <span aria-hidden="true" />
      {label}
    </div>
  );
}

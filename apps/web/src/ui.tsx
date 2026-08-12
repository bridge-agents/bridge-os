import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { useId } from "react";

/**
 * Base primitives. Everything references design tokens so that accent and
 * appearance stay themeable without touching component styles (ADR-0006).
 */

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const styles = {
    primary: "bg-accent text-[var(--bridge-accent-contrast)] hover:opacity-90",
    ghost: "border border-border text-text hover:border-border-strong hover:bg-bg-overlay",
    danger: "border border-border text-danger hover:border-danger/50 hover:bg-danger/10",
  }[variant];

  return (
    <button
      type="button"
      className={`rounded-[var(--radius-sm)] px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
      {...props}
    />
  );
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2 text-sm text-text outline-none transition placeholder:text-text-faint focus:border-border-strong ${className}`}
      {...props}
    />
  );
}

/**
 * Labelled form control. The child receives the id so the label is
 * explicitly associated with its input rather than relying on nesting.
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-text-muted">
        {label}
      </label>
      {children(id)}
      {hint && (
        <span id={hintId} className="text-xs text-text-faint">
          {hint}
        </span>
      )}
    </div>
  );
}

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={`rounded-[var(--radius-md)] border border-border bg-bg-raised p-4 ${className}`}
    >
      {children}
    </div>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? (
    <p role="alert" className="text-sm text-danger">
      {children}
    </p>
  ) : null;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-[var(--radius-md)] border border-dashed border-border px-6 py-12 text-center">
      <p className="text-sm font-medium text-text">{title}</p>
      {children && <div className="text-sm text-text-muted">{children}</div>}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <p className="py-12 text-center text-sm text-text-muted" aria-live="polite">
      {label}…
    </p>
  );
}

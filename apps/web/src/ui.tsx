import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";
import { useId } from "react";

/**
 * Base primitives. Everything references design tokens so that accent and
 * appearance stay themeable without touching component styles (ADR-0006).
 *
 * The visual language is an engineering drawing: measured rules, condensed
 * annotation labels, tight machined radii, and colour spent only where it
 * carries meaning.
 */

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "quiet";
}) {
  const styles = {
    primary:
      "bg-accent text-[var(--bridge-accent-contrast)] border border-transparent hover:opacity-90 active:opacity-80",
    ghost:
      "border border-border bg-bg-raised text-text hover:border-border-strong hover:bg-bg-overlay",
    danger: "border border-danger/40 bg-transparent text-danger hover:bg-danger/10",
    quiet: "border border-transparent text-text-muted hover:bg-bg-overlay hover:text-text",
  }[variant];

  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-sm)] px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-45 ${styles} ${className}`}
      {...props}
    />
  );
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2 text-sm text-text outline-none transition placeholder:text-text-faint hover:border-border-strong focus:border-border-strong ${className}`}
      {...props}
    />
  );
}

/**
 * Select, with the platform's own chrome removed. A native dropdown renders
 * in the OS's colours and radius, which reads as a hole punched in the page —
 * the one control that ignores every token the rest of the app obeys.
 */
export function Select({
  className = "",
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative inline-flex">
      <select
        className={`appearance-none rounded-[var(--radius-sm)] border border-border bg-bg-raised py-1.5 pl-2.5 pr-8 text-sm text-text outline-none transition hover:border-border-strong ${className}`}
        {...props}
      >
        {children}
      </select>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-faint"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
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
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={id}
        className="font-condensed text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted"
      >
        {label}
      </label>
      {children(id)}
      {hint && <span className="text-xs text-text-faint">{hint}</span>}
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

/**
 * A titled section, ruled like a drawing's title block. The dimension line
 * runs to the edge so the eye reads the heading as a measured span rather
 * than a floating label.
 */
export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <h2 className="font-condensed text-[13px] font-semibold uppercase tracking-[0.1em] text-text">
          {title}
        </h2>
        <span className="dimension" aria-hidden="true" />
        {action}
      </div>
      {description && <p className="max-w-2xl text-sm text-text-muted">{description}</p>}
    </div>
  );
}

/** Small status marker. Tone carries meaning, so it is never decorative. */
export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "success" | "warning" | "danger";
  children: ReactNode;
}) {
  const styles = {
    neutral: "border-border text-text-muted",
    success: "border-success/40 text-success",
    warning: "border-warning/40 text-warning",
    danger: "border-danger/40 text-danger",
  }[tone];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-1.5 py-0.5 font-mono text-[11px] leading-4 ${styles}`}
    >
      {children}
    </span>
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
    <div className="flex flex-col items-center gap-2 rounded-[var(--radius-md)] border border-dashed border-border px-6 py-14 text-center">
      <p className="font-condensed text-sm font-semibold uppercase tracking-[0.08em] text-text">
        {title}
      </p>
      {children && <div className="max-w-sm text-sm text-text-muted">{children}</div>}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <p
      className="py-16 text-center font-mono text-xs uppercase tracking-[0.1em] text-text-faint"
      aria-live="polite"
    >
      {label}…
    </p>
  );
}

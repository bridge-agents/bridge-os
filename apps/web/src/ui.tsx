import { AlertCircle, Inbox, Loader2 } from "lucide-react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";
import { useId } from "react";
import { Alert, AlertDescription } from "./components/ui/alert.js";
import { Badge as ShadBadge } from "./components/ui/badge.js";
import { Button as ShadButton } from "./components/ui/button.js";
import { Card as ShadCard } from "./components/ui/card.js";
import { Input as ShadInput } from "./components/ui/input.js";
import { Label } from "./components/ui/label.js";
import { Separator } from "./components/ui/separator.js";
import { cn } from "./lib/utils.js";

export function Button({
  variant = "primary",
  className,
  type = "button",
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  type?: "button" | "submit" | "reset";
  variant?: "primary" | "ghost" | "danger" | "quiet";
}) {
  const mapped = {
    primary: "default",
    ghost: "outline",
    danger: "destructive",
    quiet: "ghost",
  }[variant] as "default" | "outline" | "destructive" | "ghost";

  return <ShadButton type={type} variant={mapped} className={className} {...props} />;
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <ShadInput className={className} {...props} />;
}

/** Kept native for the legacy option-children call sites; new screens use shadcn Select. */
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative inline-flex min-w-0">
      <select
        className={cn(
          "h-8 min-w-0 appearance-none rounded-lg border border-input bg-background py-1 pl-2.5 pr-8 text-sm text-foreground outline-none transition focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
        ▾
      </span>
    </div>
  );
}

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
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <ShadCard className={cn("gap-0 rounded-lg p-4 py-4", className)}>{children}</ShadCard>;
}

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
      <div className="flex min-w-0 items-center gap-3">
        <h2 className="shrink-0 text-sm font-semibold text-foreground">{title}</h2>
        <Separator className="min-w-6 flex-1" />
        {action}
      </div>
      {description && <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "success" | "warning" | "danger";
  children: ReactNode;
}) {
  const styles = {
    neutral: "border-border bg-secondary text-secondary-foreground",
    success:
      "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
    warning:
      "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
    danger: "border-destructive/20 bg-destructive/10 text-destructive",
  }[tone];
  return (
    <ShadBadge variant="outline" className={styles}>
      {children}
    </ShadBadge>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? (
    <Alert variant="destructive" className="bg-background">
      <AlertCircle />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  ) : null;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed bg-muted/20 px-6 py-14 text-center">
      <span className="mb-2 flex size-9 items-center justify-center rounded-lg border bg-background text-muted-foreground">
        <Inbox className="size-4" />
      </span>
      <p className="font-medium text-foreground">{title}</p>
      {children && <div className="max-w-md text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div
      className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
      aria-live="polite"
    >
      <Loader2 className="size-4 animate-spin" />
      {label}
    </div>
  );
}

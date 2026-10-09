import { useId, type ComponentProps, type ReactNode } from "react";

import { cn } from "@/lib/cn";

const control =
  "block w-full rounded-md border border-line-control bg-surface px-3 text-ink placeholder:text-ink-soft " +
  "disabled:bg-canvas disabled:text-ink-soft aria-invalid:border-danger";

// Latin content (email, phone, amounts) is typed left-to-right but stays
// aligned with the Hebrew labels: in an LTR box, text-end is the right edge.
const ltrControl = "text-end";

export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cn("mb-1.5 block text-sm font-medium text-ink", className)} {...props} />;
}

// md is 44px tall (touch target); sm is for dense places such as board cards.
type ControlSize = "md" | "sm";
const heights: Record<ControlSize, string> = { md: "min-h-11", sm: "min-h-9 text-sm" };

export function Input({ className, dir, controlSize = "md", ...props }: ComponentProps<"input"> & { controlSize?: ControlSize }) {
  return <input dir={dir} className={cn(control, heights[controlSize], dir === "ltr" && ltrControl, className)} {...props} />;
}

export function Select({ className, controlSize = "md", ...props }: ComponentProps<"select"> & { controlSize?: ControlSize }) {
  return <select className={cn(control, heights[controlSize], "pe-8", className)} {...props} />;
}

export function Textarea({ className, rows = 3, ...props }: ComponentProps<"textarea">) {
  return <textarea rows={rows} className={cn(control, "py-2.5 leading-normal", className)} {...props} />;
}

type FieldShellProps = {
  label: string;
  // visually hides the label (it stays available to screen readers)
  hideLabel?: boolean;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
};

function FieldShell({
  id,
  label,
  hideLabel,
  hint,
  error,
  required,
  className,
  children,
}: FieldShellProps & { id: string; children: ReactNode }) {
  return (
    <div className={className}>
      <Label htmlFor={id} className={hideLabel ? "sr-only" : undefined}>
        {label}
        {required ? (
          <span aria-hidden="true" className="ms-0.5 text-danger">
            *
          </span>
        ) : null}
      </Label>
      {children}
      {hint && !error ? (
        <p id={`${id}-hint`} className="mt-1.5 text-sm text-ink-soft">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, hint?: string, error?: string): string | undefined {
  if (error) {
    return `${id}-error`;
  }
  return hint ? `${id}-hint` : undefined;
}

type TextFieldProps = FieldShellProps & Omit<ComponentProps<"input">, "id" | "className"> & { controlSize?: ControlSize };

/** Label + input + hint/error, wired together for assistive technology. */
export function TextField({ label, hideLabel, hint, error, required, className, ...input }: TextFieldProps) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hideLabel={hideLabel} hint={hint} error={error} required={required} className={className}>
      <Input
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...input}
      />
    </FieldShell>
  );
}

type SelectFieldProps = FieldShellProps & Omit<ComponentProps<"select">, "id" | "className"> & { controlSize?: ControlSize };

export function SelectField({ label, hideLabel, hint, error, required, className, children, ...select }: SelectFieldProps) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hideLabel={hideLabel} hint={hint} error={error} required={required} className={className}>
      <Select
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...select}
      >
        {children}
      </Select>
    </FieldShell>
  );
}

type TextareaFieldProps = FieldShellProps & Omit<ComponentProps<"textarea">, "id" | "className">;

export function TextareaField({ label, hideLabel, hint, error, required, className, ...textarea }: TextareaFieldProps) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hideLabel={hideLabel} hint={hint} error={error} required={required} className={className}>
      <Textarea
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...textarea}
      />
    </FieldShell>
  );
}

type CheckboxProps = Omit<ComponentProps<"input">, "type" | "id"> & { label: string; hint?: string };

/** A checkbox with its label; the whole row is the touch target. */
export function Checkbox({ label, hint, className, ...input }: CheckboxProps) {
  const id = useId();
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <input
        id={id}
        type="checkbox"
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="mt-0.5 size-5 shrink-0 rounded-sm border-line-control accent-[var(--color-accent)] disabled:opacity-60"
        {...input}
      />
      <div className="min-w-0">
        <label htmlFor={id} className="text-md text-ink">
          {label}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="text-sm text-ink-soft">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

type SwitchProps = Omit<ComponentProps<"button">, "onChange" | "children" | "role"> & {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
};

/** On / off that takes effect at once (a checkbox belongs to a form that is saved). */
export function Switch({ label, checked, onCheckedChange, className, disabled, ...props }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn("inline-flex min-h-11 items-center gap-3 text-md text-ink disabled:cursor-not-allowed disabled:opacity-60", className)}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 rounded-full border transition-colors",
          checked ? "border-accent bg-accent" : "border-line-control bg-canvas",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-[1.125rem] rounded-full shadow-sm transition-[inset-inline-start]",
            checked ? "start-[1.375rem] bg-on-accent" : "start-0.5 bg-ink-soft",
          )}
        />
      </span>
      {label}
    </button>
  );
}

import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import { SpinnerIcon } from "@/components/ui/icons";

import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "danger-ghost";
type Size = "md" | "sm";

const base =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap select-none " +
  "transition-colors disabled:cursor-not-allowed disabled:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-strong",
  secondary: "border border-line-strong bg-surface text-ink hover:bg-canvas",
  ghost: "text-ink hover:bg-canvas",
  danger: "bg-danger text-on-accent hover:bg-danger-strong",
  // a destructive action that should not shout until it is confirmed
  "danger-ghost": "text-danger hover:bg-danger-soft",
};

// md is 44px tall: a comfortable touch target on phones.
const sizes: Record<Size, string> = {
  md: "min-h-11 px-4 text-md",
  sm: "min-h-9 px-3 text-sm",
};

export function buttonClasses(variant: Variant = "primary", size: Size = "md", className?: string): string {
  return cn(base, variants[variant], sizes[size], className);
}

type ButtonProps = ComponentProps<"button"> & {
  variant?: Variant;
  size?: Size;
  // the action is running: the button is disabled and shows a spinner next to its text
  loading?: boolean;
};

export function Button({ variant = "primary", size = "md", className, type = "button", loading, disabled, children, ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClasses(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <SpinnerIcon className="size-4" /> : null}
      {children}
    </button>
  );
}

type IconButtonProps = Omit<ComponentProps<"button">, "children"> & {
  // the accessible name: an icon alone says nothing to a screen reader
  label: string;
  icon: ReactNode;
  variant?: Extract<Variant, "ghost" | "secondary" | "danger-ghost">;
};

/** Classes of an icon-only control, for a link that looks like IconButton. */
export function iconButtonClasses(variant: Variant = "ghost", className?: string): string {
  return cn(base, variants[variant], "size-11 shrink-0 p-0", className);
}

/** A button that is only an icon (close, reorder, more). 44px square, the size of a fingertip. */
export function IconButton({ label, icon, variant = "ghost", className, type = "button", ...props }: IconButtonProps) {
  return (
    <button type={type} aria-label={label} title={label} className={iconButtonClasses(variant, className)} {...props}>
      {icon}
    </button>
  );
}

type ButtonLinkProps = ComponentProps<typeof Link> & { variant?: Variant; size?: Size };

export function ButtonLink({ variant = "primary", size = "md", className, ...props }: ButtonLinkProps) {
  return <Link className={buttonClasses(variant, size, className)} {...props} />;
}

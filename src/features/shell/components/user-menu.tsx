"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { ChevronDownIcon } from "@/components/ui/icons";

type MenuLink = { href: string; label: string; mobileOnly?: boolean };

type Props = {
  name: string;
  email: string | null;
  roleLabel: string;
  links: MenuLink[];
  // the sign-out form, rendered on the server
  children: ReactNode;
};

/** Account menu in the top bar: a disclosure that closes on Escape, outside click and navigation. */
export function UserMenu({ name, email, roleLabel, links, children }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const initial = name.trim().charAt(0) || "?";

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-10 items-center gap-2 rounded-md px-1.5 hover:bg-canvas"
      >
        <span aria-hidden="true" className="grid size-8 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent-strong">
          {initial}
        </span>
        <span className="hidden max-w-40 truncate text-[0.9375rem] sm:block">{name}</span>
        <span className="sr-only sm:hidden">{name}</span>
        <ChevronDownIcon className="size-4 text-ink-soft" />
      </button>

      {open ? (
        <div
          id={panelId}
          className="absolute end-0 top-full z-40 mt-1.5 w-64 rounded-lg border border-line bg-surface py-1.5 shadow-[0_8px_24px_rgb(23_32_43/0.12)]"
        >
          <div className="border-b border-line px-4 pt-1.5 pb-3">
            <p className="truncate font-medium">{name}</p>
            {email ? (
              <p dir="ltr" className="truncate text-end text-sm text-ink-soft">
                {email}
              </p>
            ) : null}
            <p className="mt-0.5 text-sm text-ink-soft">{roleLabel}</p>
          </div>
          <ul className="py-1.5">
            {links.map((link) => (
              <li key={link.href} className={link.mobileOnly ? "md:hidden" : undefined}>
                <Link
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="flex min-h-10 items-center px-4 text-[0.9375rem] hover:bg-canvas"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="border-t border-line px-2.5 pt-1.5">{children}</div>
        </div>
      ) : null}
    </div>
  );
}

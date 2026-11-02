import type { ReactNode } from "react";

import { AccessibilityLink } from "@/components/accessibility-link";
import { BuiltWithLine } from "@/features/built-with/components/built-with-line";

import { OrgLogo } from "./org-logo";

const DEFAULT_LOGO_CLASS = "mb-5 h-12 max-w-48";

/** The logo's text: empty when the name is written next to it, else the name, else a neutral text. */
export function logoAlt(business: string | null, nameShown: boolean): string {
  if (!business) return "לוגו העסק";
  return nameShown ? "" : `הלוגו של ${business}`;
}

/**
 * DSN-17: the one header of every page a customer sees (form, QR sheet, booking, booking link, business card, a quote's or
 * an order's status page): the business's logo (FLD-04; a quote's or order's design may hide it, the page then passes null),
 * the page's title, and a line under it that names the business where the page knows its display name. The page around it
 * is a BrandScope, so the accent roles are the business's colour, corrected for contrast.
 * `business` null = the page does not know the business's name (a hosted form answers its logo and colour only).
 * `nameShown` (default true): the title or the line under it writes the business's name, so the logo is decorative
 * (`alt=""`, OrgLogo's rule) and a screen reader does not hear the name twice; false = the logo says "הלוגו של <name>".
 */
export function PublicBrandHeader({
  logoUrl,
  business,
  nameShown = true,
  title,
  subtitle,
  logoClassName,
  className,
  children,
}: {
  logoUrl: string | null;
  business: string | null;
  nameShown?: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  // replaces the default logo size (a bigger logo on a sheet meant for printing, the QR sheet)
  logoClassName?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <header className={className}>
      {logoUrl ? <OrgLogo url={logoUrl} alt={logoAlt(business, nameShown)} className={logoClassName ?? DEFAULT_LOGO_CLASS} /> : null}
      <h1 className="text-2xl font-semibold break-words">{title}</h1>
      {subtitle ? <p className="mt-1 text-md text-ink-soft break-words">{subtitle}</p> : null}
      {children}
    </header>
  );
}

/**
 * DSN-17: the one footer of every page a customer sees: the small "נבנה ב-Mexuz" line when the business's plan shows it
 * (FLD-04, `app.show_built_with`, rules unchanged), then the accessibility statement link (IS 5568).
 * `newTab`: the page is framed on another site (an embedded form), so the statement opens in a new tab.
 */
export function PublicPageFooter({ builtWith, newTab, className }: { builtWith: boolean; newTab?: boolean; className?: string }) {
  return (
    <footer className={className}>
      {builtWith ? <BuiltWithLine /> : null}
      <AccessibilityLink newTab={newTab} />
    </footer>
  );
}

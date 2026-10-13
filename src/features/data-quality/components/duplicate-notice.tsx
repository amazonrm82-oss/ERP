import Link from "next/link";

/**
 * Shown after a save was stopped because a matching record exists (lead form first, DQL-02 for
 * contacts and companies): a link to it, and a box to create the new one anyway.
 */
export function DuplicateNotice({ href, createLabel }: { href: string; createLabel: string }) {
  return (
    <div className="space-y-2 rounded-md border border-line p-3">
      <Link href={href} className="text-md font-medium text-accent underline underline-offset-4">
        לפתוח את הרשומה הקיימת
      </Link>
      <label className="flex items-center gap-2.5 text-md">
        <input type="checkbox" name="allow_duplicate" className="size-4.5 accent-accent" />
        {createLabel}
      </label>
    </div>
  );
}

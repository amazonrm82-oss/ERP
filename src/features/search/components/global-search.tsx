"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";

import { SearchIcon } from "@/components/ui/icons";

import { searchAction, type SearchGroup, type SearchHit } from "../actions";

const GROUP_LABELS: Record<SearchGroup, string> = {
  leads: "לידים",
  contacts: "אנשי קשר",
  companies: "חברות",
  deals: "עסקאות",
  notes: "בציר הזמן",
};

/**
 * Search everything from the top bar. Opens with the button, Ctrl+K (Cmd+K) or "/".
 * Arrow keys move between results, Enter opens one, Escape closes.
 */
export function GlobalSearch({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searched, setSearched] = useState("");
  const [active, setActive] = useState(0);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const titleId = useId();

  // keyboard shortcuts, from anywhere but a text field
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if ((event.key === "k" || event.key === "K") && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        setOpen(true);
      } else if (event.key === "/" && !typing) {
        event.preventDefault();
        setOpen(true);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // search as the user types, a moment after they stop
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const timer = setTimeout(() => {
      startTransition(async () => {
        const found = await searchAction(orgId, q);
        setHits(found);
        setSearched(q);
        setActive(0);
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [query, orgId]);

  function close() {
    setOpen(false);
    setQuery("");
    setHits([]);
    setSearched("");
    buttonRef.current?.focus();
  }

  function go(hit: SearchHit) {
    close();
    router.push(hit.href);
  }

  const shown = query.trim().length >= 2 ? hits : [];
  const groups = (Object.keys(GROUP_LABELS) as SearchGroup[]).filter((g) => shown.some((h) => h.group === g));

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-10 items-center gap-2 rounded-md px-2 text-ink-soft hover:bg-canvas sm:min-w-56 sm:border sm:border-line sm:px-3"
        aria-keyshortcuts="Control+K /"
      >
        <SearchIcon className="size-5 shrink-0" />
        <span className="sr-only sm:not-sr-only sm:text-md">
          חיפוש<span className="sr-only"> בכל המערכת</span>
        </span>
        <kbd dir="ltr" className="ms-auto hidden rounded border border-line px-1.5 text-xs lg:inline">
          Ctrl K
        </kbd>
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 px-3 pt-[10vh]" onMouseDown={(e) => e.target === e.currentTarget && close()}>
          <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-xl overflow-hidden rounded-lg bg-surface shadow-[0_16px_48px_rgb(23_32_43/0.25)]">
            <h2 id={titleId} className="sr-only">
              חיפוש בכל המערכת
            </h2>
            <div className="flex items-center gap-2 border-b border-line px-3">
              <SearchIcon className="size-5 shrink-0 text-ink-soft" aria-hidden="true" />
              <input
                ref={inputRef}
                type="search"
                role="combobox"
                aria-expanded={shown.length > 0}
                aria-controls={listId}
                aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
                aria-label="חיפוש לידים, אנשי קשר, חברות, עסקאות והערות"
                placeholder="שם, טלפון, אימייל, ח.פ. או מילה מהערה"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    close();
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActive((i) => Math.min(i + 1, shown.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActive((i) => Math.max(i - 1, 0));
                  } else if (e.key === "Enter" && shown[active]) {
                    e.preventDefault();
                    go(shown[active]);
                  }
                }}
                className="min-h-14 w-full bg-transparent text-base outline-none"
              />
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {query.trim().length < 2 ? (
                <p className="px-4 py-4 text-sm text-ink-soft">הקלידו לפחות שתי אותיות.</p>
              ) : shown.length === 0 && !pending && searched === query.trim() ? (
                <p className="px-4 py-4 text-sm text-ink-soft" role="status">
                  לא נמצא דבר.
                </p>
              ) : null}
              <ul id={listId} role="listbox" aria-label="תוצאות">
                {groups.map((group) => (
                  <li key={group} role="presentation">
                    <p className="bg-canvas px-4 py-1.5 text-xs font-semibold text-ink-soft">{GROUP_LABELS[group]}</p>
                    <ul role="presentation">
                      {shown.map((hit, index) =>
                        hit.group === group ? (
                          <li
                            key={hit.key}
                            id={`${listId}-${index}`}
                            role="option"
                            aria-selected={index === active}
                            onMouseEnter={() => setActive(index)}
                            onClick={() => go(hit)}
                            className={`cursor-pointer px-4 py-2.5 ${index === active ? "bg-accent-soft" : ""}`}
                          >
                            <span className="block truncate font-medium">{hit.title}</span>
                            {hit.subtitle ? <span className="block truncate text-sm text-ink-soft">{hit.subtitle}</span> : null}
                          </li>
                        ) : null,
                      )}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
            <p className="hidden border-t border-line px-4 py-2 text-xs text-ink-soft sm:block">
              חצים לבחירה · Enter לפתיחה · Esc לסגירה
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}

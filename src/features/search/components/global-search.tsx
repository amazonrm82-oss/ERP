"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";

import { IconButton } from "@/components/ui/button";
import { CloseIcon, SearchIcon } from "@/components/ui/icons";

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
  const dialogRef = useRef<HTMLDialogElement>(null);
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

  // a real modal (FXA-04): the browser keeps focus inside and makes the page behind inert
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      inputRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // the highlighted result stays in view while the arrows move it (FXA-04)
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, open, listId]);

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

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
        onMouseDown={(e) => e.target === e.currentTarget && close()}
        className="mx-auto mt-[10vh] w-[calc(100%-1.5rem)] max-w-xl overflow-hidden rounded-lg bg-surface p-0 text-ink shadow-xl backdrop:bg-brand/60"
      >
        {open ? (
          <div>
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
              <IconButton label="סגירת החיפוש" icon={<CloseIcon className="size-5" />} onClick={close} className="-me-1" />
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
                            className={`cursor-pointer px-4 py-2.5 ${index === active ? "bg-accent-soft ring-2 ring-accent ring-inset" : ""}`}
                          >
                            <span className="block truncate font-medium">
                              <bdi>{hit.title}</bdi>
                            </span>
                            {hit.subtitle ? (
                              // FXA-07: a phone or email keeps its own direction; a leading + stays in front
                              <span className="block truncate text-sm text-ink-soft">
                                <bdi>{hit.subtitle}</bdi>
                              </span>
                            ) : null}
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
        ) : null}
      </dialog>
    </>
  );
}

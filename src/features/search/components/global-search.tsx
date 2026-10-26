"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";

import { IconButton } from "@/components/ui/button";
import { CloseIcon, SearchIcon } from "@/components/ui/icons";

import { commandsAction, searchAction, type SearchGroup, type SearchHit } from "../actions";
import { COMMAND_GROUP_LABELS, matchCommands, type Command, type CommandGroup } from "../command-match";
import { isSearchShortcut } from "../shortcut";

const GROUP_LABELS: Record<SearchGroup, string> = {
  leads: "לידים",
  contacts: "אנשי קשר",
  companies: "חברות",
  deals: "עסקאות",
  notes: "בציר הזמן",
};

type Section = CommandGroup | SearchGroup;
// REC-09: actions and places first, then the records
const SECTION_ORDER: Section[] = ["create", "navigate", "settings", "leads", "contacts", "companies", "deals", "notes"];
const SECTION_LABELS: Record<Section, string> = { ...COMMAND_GROUP_LABELS, ...GROUP_LABELS };

type Item = { key: string; section: Section; title: string; subtitle: string | null; href: string };

/**
 * Search everything from the top bar. Opens with the button or Ctrl+K (Cmd+K).
 * REC-09: besides records it offers actions ("ליד חדש") and places ("הגדרות") that match the text.
 * Arrow keys move between results, Enter opens one, Escape closes.
 */
export function GlobalSearch({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  // REC-09: what this person may do and open, asked once when the palette first opens
  const [commands, setCommands] = useState<Command[] | null>(null);
  const [searched, setSearched] = useState("");
  const [active, setActive] = useState(0);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listId = useId();
  const titleId = useId();

  // the keyboard shortcut: only with Ctrl or Cmd (FXA-09, WCAG 2.1.4: a one-key shortcut cannot be turned off and
  // fires for speech input users)
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (isSearchShortcut(event)) {
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

  // REC-09: the commands are read once, the first time the palette opens
  useEffect(() => {
    if (!open || commands !== null) return;
    let live = true;
    commandsAction(orgId)
      .then((list) => live && setCommands(list))
      .catch(() => live && setCommands([]));
    return () => {
      live = false;
    };
  }, [open, commands, orgId]);

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

  function go(item: Item) {
    close();
    router.push(item.href);
  }

  const typed = query.trim();
  const matched = useMemo(() => (typed.length >= 2 && commands ? matchCommands(commands, typed) : []), [commands, typed]);
  // one list in the order it is shown, so the arrows and the highlighted row agree
  const shown: Item[] = useMemo(() => {
    if (typed.length < 2) return [];
    const items: Item[] = [
      ...matched.map((c) => ({ key: c.key, section: c.group, title: c.label, subtitle: c.hint, href: c.href })),
      ...hits.map((h) => ({ key: h.key, section: h.group, title: h.title, subtitle: h.subtitle, href: h.href })),
    ];
    return SECTION_ORDER.flatMap((section) => items.filter((item) => item.section === section));
  }, [typed, matched, hits]);
  const groups = SECTION_ORDER.filter((g) => shown.some((h) => h.section === g));
  const activeIndex = Math.min(active, Math.max(shown.length - 1, 0));

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-10 items-center gap-2 rounded-md px-2 text-ink-soft hover:bg-canvas sm:min-w-56 sm:border sm:border-line sm:px-3"
        aria-keyshortcuts="Control+K Meta+K"
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
                aria-activedescendant={shown[activeIndex] ? `${listId}-${activeIndex}` : undefined}
                aria-label="חיפוש רשומות, פעולות ומסכים"
                placeholder="שם, טלפון, מילה מהערה, או פעולה כמו &quot;הגדרות&quot;"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    close();
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActive(Math.min(activeIndex + 1, shown.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActive(Math.max(activeIndex - 1, 0));
                  } else if (e.key === "Enter" && shown[activeIndex]) {
                    e.preventDefault();
                    go(shown[activeIndex]);
                  }
                }}
                className="min-h-14 w-full bg-transparent text-base outline-none"
              />
              <IconButton label="סגירת החיפוש" icon={<CloseIcon className="size-5" />} onClick={close} className="-me-1" />
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {typed.length < 2 ? (
                <p className="px-4 py-4 text-sm text-ink-soft">הקלידו לפחות שתי אותיות. אפשר גם פעולה או מסך, כמו &quot;משימה חדשה&quot; או &quot;הגדרות&quot;.</p>
              ) : shown.length === 0 && !pending && searched === typed ? (
                <p className="px-4 py-4 text-sm text-ink-soft" role="status">
                  לא נמצא דבר.
                </p>
              ) : null}
              <ul id={listId} role="listbox" aria-label="תוצאות">
                {groups.map((group) => (
                  <li key={group} role="presentation">
                    <p className="bg-canvas px-4 py-1.5 text-xs font-semibold text-ink-soft">{SECTION_LABELS[group]}</p>
                    <ul role="presentation">
                      {shown.map((hit, index) =>
                        hit.section === group ? (
                          <li
                            key={hit.key}
                            id={`${listId}-${index}`}
                            role="option"
                            aria-selected={index === activeIndex}
                            onMouseEnter={() => setActive(index)}
                            onClick={() => go(hit)}
                            className={`cursor-pointer px-4 py-2.5 ${index === activeIndex ? "bg-accent-soft ring-2 ring-accent ring-inset" : ""}`}
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

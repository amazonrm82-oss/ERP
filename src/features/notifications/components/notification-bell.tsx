"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition } from "react";

import { BellIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import type { NotificationRow } from "@/lib/database.types";
import { formatDateTime } from "@/lib/format";
import { paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/client";

import { markNotificationsReadAction } from "../actions";
import { notificationHref } from "../links";
import type { NotificationView } from "../queries";

type Props = { orgId: string; userId: string; initial: NotificationView[]; unread: number };

const SHOWN = 8;

/**
 * Bell in the top bar: unread count, the latest notifications, and new ones
 * arriving live (Supabase Realtime; RLS sends each user only their own rows).
 */
export function NotificationBell({ orgId, userId, initial, unread: initialUnread }: Props) {
  const [items, setItems] = useState(initial);
  const [unread, setUnread] = useState(initialUnread);
  const [announcement, setAnnouncement] = useState("");
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    let supabase: ReturnType<typeof createClient>;
    try {
      supabase = createClient();
    } catch {
      return;
    }
    let cancelled = false;
    const channel = supabase.channel(`notifications:${userId}`);
    channel.on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` },
      (payload) => {
        const row = payload.new as NotificationRow;
        if (row.organization_id !== orgId) {
          return;
        }
        const view: NotificationView = {
          id: row.id,
          title: row.title,
          body: row.body,
          href: notificationHref(orgId, row.entity_type, row.entity_id),
          read: row.read_at !== null,
          when: formatDateTime(row.created_at),
          createdAt: row.created_at,
        };
        setItems((current) => (current.some((item) => item.id === view.id) ? current : [view, ...current]));
        if (!view.read) {
          setUnread((count) => count + 1);
        }
        setAnnouncement(`התראה חדשה: ${view.title}`);
      },
    );
    // the socket needs the user's token, or RLS lets nothing through
    void supabase.realtime.setAuth().then(() => {
      if (!cancelled) {
        channel.subscribe();
      }
    });
    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [orgId, userId]);

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

  function markRead(id: string | null) {
    // shown at once; the bell is re-read from the server on the next navigation anyway
    setItems((current) => current.map((item) => (id === null || item.id === id ? { ...item, read: true } : item)));
    setUnread((count) => (id === null ? 0 : Math.max(0, count - (items.some((item) => item.id === id && !item.read) ? 1 : 0))));
    startTransition(async () => {
      await markNotificationsReadAction(orgId, id);
    });
  }

  const label = unread > 0 ? `התראות, ${unread} לא נקראו` : "התראות";

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
        className="relative grid size-10 place-items-center rounded-md text-ink-soft hover:bg-canvas hover:text-ink"
      >
        <BellIcon className="size-5.5" />
        {unread > 0 ? (
          <span
            aria-hidden="true"
            className="absolute end-1 top-1 grid min-w-4.5 place-items-center rounded-full bg-danger px-1 text-2xs leading-4.5 font-semibold text-on-accent"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>
      <p role="status" className="sr-only">
        {announcement}
      </p>

      {open ? (
        <div
          id={panelId}
          className="max-sm:fixed max-sm:inset-x-2 max-sm:top-16 max-sm:mt-0 max-sm:w-auto max-sm:max-h-[calc(100dvh-10rem)] max-sm:overflow-y-auto sm:absolute sm:end-0 sm:top-full z-40 mt-1.5 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface shadow-[0_8px_24px_rgb(23_32_43/0.12)]"
        >
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
            <h2 className="font-semibold">התראות</h2>
            {unread > 0 ? (
              <button type="button" onClick={() => markRead(null)} className="rounded-md px-1.5 py-1 text-sm text-accent-strong hover:underline">
                סימון הכל כנקרא
              </button>
            ) : null}
          </div>
          {items.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-ink-soft">אין התראות.</p>
          ) : (
            <ul className="max-h-[60dvh] divide-y divide-line overflow-y-auto">
              {items.slice(0, SHOWN).map((item) => (
                <li key={item.id}>
                  <NotificationLink
                    item={item}
                    onOpen={() => {
                      setOpen(false);
                      if (!item.read) {
                        markRead(item.id);
                      }
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-line px-4 py-2.5 text-center">
            <Link href={paths.notifications(orgId)} onClick={() => setOpen(false)} className="text-sm text-accent-strong hover:underline">
              לכל ההתראות ולהגדרות הנייד
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function NotificationLink({ item, onOpen }: { item: NotificationView; onOpen: () => void }) {
  const content = (
    <>
      <span className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className={cn("mt-2 size-2 shrink-0 rounded-full", item.read ? "bg-transparent" : "bg-accent")}
        />
        <span className="min-w-0">
          <span className={cn("block break-words", !item.read && "font-semibold")}>{item.title}</span>
          {item.body ? <span className="block break-words text-sm text-ink-soft">{item.body}</span> : null}
          <span className="block text-xs text-ink-soft">
            {item.when}
            {item.read ? null : <span className="sr-only"> (לא נקראה)</span>}
          </span>
        </span>
      </span>
    </>
  );
  const className = "block w-full px-4 py-3 text-start hover:bg-canvas";
  return item.href ? (
    <Link href={item.href} onClick={onOpen} className={className}>
      {content}
    </Link>
  ) : (
    <button type="button" onClick={onOpen} className={className}>
      {content}
    </button>
  );
}

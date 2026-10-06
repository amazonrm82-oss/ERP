"use client";

import { useState, useTransition } from "react";

import { markNotificationsReadAction } from "../actions";
import type { NotificationView } from "../queries";
import { NotificationLink } from "./notification-bell";

/** The full list: opening a notification marks it read. */
export function NotificationList({ orgId, items: initial }: { orgId: string; items: NotificationView[] }) {
  const [items, setItems] = useState(initial);
  const [, startTransition] = useTransition();
  return (
    <ul className="divide-y divide-line">
      {items.map((item) => (
        <li key={item.id}>
          <NotificationLink
            item={item}
            onOpen={() => {
              if (item.read) return;
              setItems((current) => current.map((i) => (i.id === item.id ? { ...i, read: true } : i)));
              startTransition(async () => {
                await markNotificationsReadAction(orgId, item.id);
              });
            }}
          />
        </li>
      ))}
    </ul>
  );
}

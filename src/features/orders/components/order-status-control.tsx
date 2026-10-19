"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { Select } from "@/components/ui/field";

import { setOrderStatusAction } from "../actions";
import { MOVABLE_STATUSES, ORDER_STATUS_LABELS, type OrderStatus } from "../schema";

/** ORD-02: moves a numbered order between new, in progress, partly delivered and delivered. */
export function OrderStatusControl({ orgId, orderId, status }: { orgId: string; orderId: string; status: OrderStatus }) {
  const [value, setValue] = useState<string>(status);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label>
        <span className="mb-1.5 block text-sm font-medium">מצב ההזמנה</span>
        <Select value={value} onChange={(event) => setValue(event.target.value)} className="w-44" disabled={pending}>
          {MOVABLE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {ORDER_STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
      </label>
      <Button
        variant="secondary"
        disabled={pending || value === status}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await setOrderStatusAction(orgId, orderId, value);
            if (!result.ok) setError(result.message);
          });
        }}
      >
        {pending ? "שומרים…" : "עדכון המצב"}
      </Button>
      <FormError message={error} className="w-full" />
    </div>
  );
}

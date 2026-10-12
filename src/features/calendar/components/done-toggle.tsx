"use client";

import { useRouter } from "next/navigation";
import { useOptimistic, useTransition } from "react";

import { Switch } from "@/components/ui/field";

type Props = {
  checked: boolean;
  // the same calendar address with `done=1` on / off (made on the server)
  onHref: string;
  offHref: string;
};

/**
 * CAL-02: "show what was done or cancelled". Done tasks and cancelled / no-show
 * meetings are hidden by default; the switch puts `done=1` in the URL, and the
 * server then sends them too (struck through).
 */
export function CalendarDoneToggle({ checked, onHref, offHref }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(checked);

  return (
    <Switch
      label="הצגת מה שבוצע או בוטל"
      checked={shown}
      aria-busy={pending}
      onCheckedChange={(next) =>
        startTransition(() => {
          setShown(next);
          router.push(next ? onHref : offHref, { scroll: false });
        })
      }
    />
  );
}

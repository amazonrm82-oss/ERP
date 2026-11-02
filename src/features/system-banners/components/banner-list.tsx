"use client";

import { useState, useTransition } from "react";

import { IconButton } from "@/components/ui/button";
import { CloseIcon } from "@/components/ui/icons";

import { dismissBannerAction } from "../actions";
import type { SystemBanner } from "../banners";

const TONE = {
  info: "border-line bg-accent-soft text-accent-strong",
  warning: "border-line bg-warning-soft text-warning",
} as const;

export function BannerList({ orgId, banners }: { orgId: string; banners: SystemBanner[] }) {
  const [hidden, setHidden] = useState<string[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const shown = banners.filter((banner) => !hidden.includes(banner.id));
  if (shown.length === 0) return null;

  function dismiss(id: string) {
    setHidden((list) => [...list, id]);
    setFailed(null);
    startTransition(async () => {
      const result = await dismissBannerAction(orgId, id);
      if (!result.ok) {
        setHidden((list) => list.filter((item) => item !== id));
        setFailed(result.message);
      }
    });
  }

  return (
    <div aria-label="הודעות מערכת" role="region">
      {shown.map((banner) => (
        <div key={banner.id} role="status" className={`flex items-start gap-2 border-b px-4 py-2 text-sm sm:px-6 ${TONE[banner.severity]}`}>
          <p className="min-w-0 flex-1 py-1.5 break-words">
            <span className="sr-only">{banner.severity === "warning" ? "הודעה חשובה: " : "הודעה: "}</span>
            {banner.body}
          </p>
          {banner.dismissable ? (
            <IconButton label="סגירת ההודעה" icon={<CloseIcon className="size-4" />} className="shrink-0" onClick={() => dismiss(banner.id)} />
          ) : null}
        </div>
      ))}
      {failed ? (
        <p role="alert" className="border-b border-line bg-danger-soft px-4 py-2 text-sm text-danger-strong sm:px-6">
          {failed}
        </p>
      ) : null}
    </div>
  );
}

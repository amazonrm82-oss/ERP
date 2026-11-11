"use client";

import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { Input, Label, Select } from "@/components/ui/field";

import { createPreferenceLinkAction } from "../actions";
import { PREFERENCE_CHANNEL_LABELS, type PreferenceChannel } from "../model";

type Props = { orgId: string; subject: { kind: "lead" | "contact"; id: string }; channels: PreferenceChannel[] };

/**
 * CNS-10: owners and admins make a fresh link to the customer's preferences page for one channel, to copy and send by hand.
 * The link is shown once (only its hash is kept); a new one replaces the earlier one, which keeps only unsubscribing.
 * RVW-82: a link copied here only unsubscribes; it never re-subscribes the customer.
 */
export function PreferenceLinkButton({ orgId, subject, channels }: Props) {
  const selectId = useId();
  const inputId = useId();
  const [channel, setChannel] = useState<PreferenceChannel>(channels[0]);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function create() {
    setError(null);
    setCopied(false);
    setBusy(true);
    const result = await createPreferenceLinkAction(orgId, subject, channel);
    setBusy(false);
    if (!result.ok) setError(result.message);
    else setUrl(result.data?.url ?? null);
  }

  async function copy(text: string) {
    setError(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setError("ההעתקה לא הצליחה. סמנו את הקישור והעתיקו ידנית.");
    }
  }

  return (
    <div className="space-y-3 border-t border-line pt-3">
      <p className="text-md font-medium">קישור להעדפות הדיוור</p>
      <p className="text-sm text-ink-soft">הקישור שמעתיקים כאן מאפשר רק הסרה מדיוור, לא הרשמה מחדש.</p>
      <FormError message={error} />
      {url ? (
        <div className="space-y-2">
          <Label htmlFor={inputId}>הקישור ({PREFERENCE_CHANNEL_LABELS[channel]})</Label>
          <Input id={inputId} dir="ltr" readOnly value={url} onFocus={(event) => event.currentTarget.select()} className="font-mono text-sm" />
          <p className="text-sm text-ink-soft">הקישור מוצג רק עכשיו. קישור קודם לערוץ הזה מאפשר מעכשיו רק הסרה.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => void copy(url)}>
              {copied ? "הועתק" : "העתקת הקישור"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setUrl(null)}>
              סיום
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor={selectId}>ערוץ</Label>
            <Select id={selectId} controlSize="sm" value={channel} onChange={(event) => setChannel(event.target.value as PreferenceChannel)}>
              {channels.map((c) => (
                <option key={c} value={c}>
                  {PREFERENCE_CHANNEL_LABELS[c]}
                </option>
              ))}
            </Select>
          </div>
          <Button size="sm" variant="secondary" onClick={() => void create()} disabled={busy}>
            {busy ? "יוצרים…" : "יצירת קישור"}
          </Button>
        </div>
      )}
    </div>
  );
}

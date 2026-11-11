"use client";

import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";

import {
  channelPhrase,
  PREFERENCES_TEXTS,
  preferencesSubmitPath,
  STATE_TEXTS,
  type PreferenceChannel,
  type PreferenceChannelRow,
  type PreferenceResult,
} from "../model";

type Reply = { ok: true; results?: { channel: PreferenceChannel; result: PreferenceResult }[] } | { ok: false; message: string };

/**
 * CNS-10: the link's own channel, one switch (review 1: a link sent on one channel never turns another one on, and the page
 * does not say which other channels the business holds an address for), and "הסרה מכל הערוצים". The switch turns on only
 * where the database allows it (never over an erasure, a manual or SMS-reply blocklist entry, or another opt-out), so its
 * box is disabled otherwise.
 */
export function PreferencesForm({ token, channels, staffLink = false }: { token: string; channels: PreferenceChannelRow[]; staffLink?: boolean }) {
  const [rows, setRows] = useState(channels);
  const [picked, setPicked] = useState<Record<string, boolean>>(() => Object.fromEntries(channels.map((c) => [c.channel, c.state === "in"])));
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function post(body: object): Promise<Reply> {
    const res = await fetch(preferencesSubmitPath(token), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Reply;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    const choices = rows
      .filter((row) => picked[row.channel] !== (row.state === "in"))
      .map((row) => ({ channel: row.channel, on: picked[row.channel] }));
    if (choices.length === 0) {
      setNotice(PREFERENCES_TEXTS.saved);
      return;
    }
    setPending(true);
    try {
      const reply = await post({ choices });
      if (!reply.ok) {
        setError(reply.message);
        return;
      }
      const results = new Map((reply.results ?? []).map((r) => [r.channel, r.result]));
      setRows((current) =>
        current.map((row) => (results.get(row.channel) === "saved" ? { ...row, state: picked[row.channel] ? "in" : "out", canTurnOn: !picked[row.channel] && !staffLink } : row)),
      );
      setPicked((current) => {
        const next = { ...current };
        for (const [channel, result] of results) if (result === "refused") next[channel] = false;
        return next;
      });
      if ([...results.values()].includes("refused")) setError(PREFERENCES_TEXTS.refused);
      else setNotice(PREFERENCES_TEXTS.saved);
    } catch {
      setError("אין חיבור לשרת כרגע. בדקו את החיבור לאינטרנט ונסו שוב.");
    } finally {
      setPending(false);
    }
  }

  async function removeAll() {
    setError(null);
    setNotice(null);
    setRemoving(true);
    try {
      const reply = await post({ all: true });
      if (!reply.ok) {
        setError(reply.message);
        return;
      }
      // delta review 4: the person's own removal can be undone from the page (owner (231) ב); the server judges it again
      // RVW-82: a link copied by staff never turns a channel on
      setRows((current) => current.map((row) => ({ ...row, state: "out", canTurnOn: !staffLink })));
      setPicked((current) => Object.fromEntries(Object.keys(current).map((channel) => [channel, false])));
      setNotice(PREFERENCES_TEXTS.removedAll);
    } catch {
      setError("אין חיבור לשרת כרגע. בדקו את החיבור לאינטרנט ונסו שוב.");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError message={error} />
        <FormNotice message={notice} />
        {rows.map((row) => {
          const on = picked[row.channel];
          const locked = row.state !== "in" && !row.canTurnOn;
          const hintId = `prefs-${row.channel}-state`;
          return (
            <label key={row.channel} className="flex items-start gap-3 rounded-md border border-line bg-surface p-3 text-md">
              <input
                type="checkbox"
                name={row.channel}
                checked={on}
                disabled={removing || (locked && !on)}
                aria-describedby={hintId}
                onChange={(event) => setPicked((current) => ({ ...current, [row.channel]: event.target.checked }))}
                className="mt-1 size-4 accent-accent"
              />
              <span className="min-w-0">
                <span className="block font-medium">{`הודעות שיווקיות ב${channelPhrase(row.channel)}`}</span>
                <span id={hintId} className="block text-sm text-ink-soft">
                  {STATE_TEXTS[row.state]}
                </span>
              </span>
            </label>
          );
        })}
        <SubmitButton pending={pending} pendingText="שומרים…" className="w-full">
          שמירה
        </SubmitButton>
      </form>
      <div className="space-y-2 border-t border-line pt-4">
        <p className="text-sm text-ink-soft">{PREFERENCES_TEXTS.removeAllLine}</p>
        <Button variant="secondary" className="w-full" onClick={() => void removeAll()} disabled={removing}>
          {removing ? "מסירים…" : PREFERENCES_TEXTS.removeAll}
        </Button>
      </div>
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

import { roadmapVoteAction } from "../actions";
import { votesText } from "../items";

type Props = { orgId: string; itemId: string; title: string; votes: number; voted: boolean; canVote: boolean };

/** TRU-01: the business's one vote on an item. Owners and admins press it; everyone else sees the count and the state. */
export function RoadmapVote({ orgId, itemId, title, votes: initialVotes, voted: initialVoted, canVote }: Props) {
  const [votes, setVotes] = useState(initialVotes);
  const [voted, setVoted] = useState(initialVoted);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle() {
    setError(null);
    startTransition(async () => {
      const result = await roadmapVoteAction(orgId, itemId, !voted);
      if (result.ok && result.data) {
        setVotes(result.data.votes);
        setVoted(result.data.voted);
      } else if (!result.ok) {
        setError(result.message);
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="text-sm text-ink-soft" aria-live="polite">
        {votesText(votes)}
        {voted ? " · העסק שלכם הצביע" : null}
      </p>
      {canVote ? (
        <Button
          size="sm"
          variant={voted ? "secondary" : "primary"}
          loading={pending}
          aria-pressed={voted}
          aria-label={voted ? `ביטול ההצבעה על ${title}` : `הצבעה על ${title}`}
          onClick={toggle}
        >
          {voted ? "ביטול ההצבעה" : "חשוב לנו"}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="w-full text-sm text-danger-strong">
          {error}
        </p>
      ) : null}
    </div>
  );
}

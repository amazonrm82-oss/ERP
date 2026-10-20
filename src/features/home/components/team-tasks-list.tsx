"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { takeTaskAction } from "@/features/tasks/actions";

import type { TeamTaskDue } from "../my-day";

export type TeamTaskView = {
  id: string;
  title: string;
  due: TeamTaskDue;
  teamName: string;
  related: { href: string; kind: string; name: string } | null;
};

/**
 * TASK-07 follow-up: the team tasks on My day, each with "לקחתי" (public.take_task; the first one wins). The answer is kept
 * here, above the rows, because a taken task leaves the list as soon as the page is refreshed.
 */
export function TeamTasksList({ orgId, tasks, canTake }: { orgId: string; tasks: TeamTaskView[]; canTake: boolean }) {
  const [pending, startTransition] = useTransition();
  const [takingId, setTakingId] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ ok: boolean; message: string } | null>(null);

  function take(task: TeamTaskView) {
    setAnswer(null);
    setTakingId(task.id);
    startTransition(async () => {
      const result = await takeTaskAction(orgId, task.id);
      setAnswer(result.ok ? { ok: true, message: `"${task.title}": ${result.message ?? "המשימה עכשיו באחריותך."}` } : { ok: false, message: result.message });
      setTakingId(null);
    });
  }

  return (
    <>
      {answer && !answer.ok ? (
        <p role="alert" className="mb-3 text-sm text-danger">
          {answer.message}
        </p>
      ) : null}
      <p role="status" className="mb-3 text-sm text-ink-soft empty:hidden">
        {answer?.ok ? answer.message : null}
      </p>
      {tasks.length > 0 ? (
        <ul className="divide-y divide-line">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <span className="min-w-0">
                <span className="block break-words">{task.title}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-soft">
                  {task.due.kind === "overdue" ? <Badge tone="danger">באיחור</Badge> : null}
                  {task.due.text ? <span className={task.due.kind === "later" ? undefined : "tabular-nums"}>{task.due.text}</span> : null}
                  <span>
                    צוות <bdi>{task.teamName}</bdi>
                  </span>
                  {task.related ? (
                    <Link href={task.related.href} className="text-accent-strong underline-offset-4 hover:underline">
                      {task.related.kind}: <bdi>{task.related.name}</bdi>
                    </Link>
                  ) : null}
                </span>
              </span>
              {canTake ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="shrink-0 print:hidden"
                  onClick={() => take(task)}
                  disabled={pending}
                  aria-busy={takingId === task.id || undefined}
                >
                  {takingId === task.id ? "לוקחים…" : "לקחתי"}
                  <span className="sr-only">: {task.title}</span>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

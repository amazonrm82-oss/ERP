import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import type { TimelineSubject } from "@/features/activities/schema";
import { SUBJECT_COLUMN } from "@/features/activities/schema";
import { formatDateTime } from "@/lib/format";

import { listRecordTasks } from "../queries";
import { CompleteTaskButton } from "./complete-task-button";
import { RecordTaskForm } from "./record-task-form";

type Props = { orgId: string; subject: TimelineSubject; canWrite: boolean };

/**
 * The "משימות" card of a lead, contact, company or deal (FXU-01): its open
 * tasks, each done in one tap, and a task added in one line without leaving the record.
 */
export async function RecordTasks({ orgId, subject, canWrite }: Props) {
  const tasks = await listRecordTasks(orgId, SUBJECT_COLUMN[subject.kind], subject.id);
  return (
    <Card aria-labelledby="record-tasks-title">
      <CardHeader id="record-tasks-title" title={tasks.length > 0 ? `משימות (${tasks.length})` : "משימות"} />
      <CardBody className="space-y-4">
        {canWrite ? <RecordTaskForm orgId={orgId} subject={subject} /> : null}
        {tasks.length === 0 ? (
          <p className="text-md text-ink-soft">אין משימות פתוחות לרשומה הזו.</p>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {tasks.map((task) => {
              return (
                <li key={task.id} className="flex items-start justify-between gap-3 py-3 last:pb-0">
                  <span className="min-w-0">
                    <span className="block break-words">{task.title}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
                      {task.isOverdue ? <Badge tone="danger">באיחור</Badge> : null}
                      {task.dueAt ? <time dateTime={task.dueAt}>{formatDateTime(task.dueAt)}</time> : <span>בלי תאריך</span>}
                      {task.ownerName ? <span>· {task.ownerName}</span> : null}
                    </span>
                  </span>
                  {canWrite ? <CompleteTaskButton orgId={orgId} taskId={task.id} title={task.title} /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

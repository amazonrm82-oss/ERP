import type { Metadata } from "next";
import Link from "next/link";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page-header";
import { listMembers } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { TaskForm } from "@/features/tasks/components/task-form";
import { TaskRow, type TaskRowView } from "@/features/tasks/components/task-row";
import { listTaskGroups, type TaskItem } from "@/features/tasks/queries";
import { cn } from "@/lib/cn";
import { formatDateTime, formatNumber, zoneDate, zoneTime } from "@/lib/format";
import { paths } from "@/lib/paths";
import { firstParam } from "@/lib/search";

export const metadata: Metadata = { title: "משימות" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const RELATED_LABEL = { lead: "לליד", contact: "לאיש הקשר", company: "לחברה", deal: "לעסקה" } as const;

function relatedHref(orgId: string, related: NonNullable<TaskItem["related"]>): string {
  switch (related.kind) {
    case "lead":
      return paths.lead(orgId, related.id);
    case "contact":
      return paths.contact(orgId, related.id);
    case "company":
      return paths.company(orgId, related.id);
    case "deal":
      return paths.deal(orgId, related.id);
  }
}

export default async function TasksPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const { user, canWrite } = await getOrgContext(orgId);
  const showAll = firstParam((await searchParams).who) === "all";

  const [groups, members] = await Promise.all([listTaskGroups(orgId, showAll ? null : user.id), listMembers(orgId)]);
  const assignees = members
    .filter((member) => member.status === "active" && member.role !== "viewer")
    .map((member) => ({ userId: member.userId, name: member.userId === user.id ? `${member.name} (אני)` : member.name }));

  const view = (task: TaskItem, overdue: boolean): TaskRowView => {
    const due = task.dueAt ? new Date(task.dueAt) : null;
    return {
      id: task.id,
      title: task.title,
      done: task.completedAt !== null,
      overdue,
      dueText: task.dueAt ? formatDateTime(task.dueAt) : null,
      dueDate: due ? zoneDate(due) : null,
      dueTime: due ? zoneTime(due) : null,
      completedText: task.completedAt ? formatDateTime(task.completedAt) : null,
      ownerId: task.ownerId,
      ownerName: task.ownerName,
      related: task.related ? { href: relatedHref(orgId, task.related), label: RELATED_LABEL[task.related.kind] } : null,
    };
  };

  const sections: Array<{ key: string; title: string; tasks: TaskItem[]; overdue?: boolean }> = [
    { key: "overdue", title: "באיחור", tasks: groups.overdue, overdue: true },
    { key: "today", title: "היום", tasks: groups.today },
    { key: "upcoming", title: "בהמשך", tasks: groups.upcoming },
    { key: "undated", title: "בלי תאריך", tasks: groups.undated },
  ];
  const openCount = sections.reduce((sum, section) => sum + section.tasks.length, 0);
  const tabClass = (active: boolean) =>
    cn(
      "-mb-px flex min-h-11 items-center border-b-2 px-3 text-[0.9375rem] whitespace-nowrap",
      active ? "border-accent font-semibold text-accent-strong" : "border-transparent text-ink-soft hover:text-ink",
    );

  return (
    <>
      <PageHeader title="משימות" description={`${formatNumber(openCount)} משימות פתוחות.`} />

      <nav aria-label="של מי המשימות" className="mb-5 border-b border-line">
        <ul className="flex gap-1">
          <li>
            <Link href={paths.tasks(orgId)} aria-current={showAll ? undefined : "page"} className={tabClass(!showAll)}>
              שלי
            </Link>
          </li>
          <li>
            <Link href={`${paths.tasks(orgId)}?who=all`} aria-current={showAll ? "page" : undefined} className={tabClass(showAll)}>
              כל המשימות שאני רואה
            </Link>
          </li>
        </ul>
      </nav>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-5">
          {groups.truncated ? (
            <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
              מוצגות 300 המשימות הפתוחות הראשונות לפי תאריך יעד.
            </p>
          ) : null}
          {openCount === 0 ? (
            <div className="rounded-lg border border-line bg-surface">
              <EmptyState title="אין משימות פתוחות" description="משימה חדשה מוסיפים בטופס שבצד. אפשר להטיל משימה גם על חבר צוות." />
            </div>
          ) : (
            sections
              .filter((section) => section.tasks.length > 0)
              .map((section) => (
                <Card key={section.key} aria-labelledby={`tasks-${section.key}`}>
                  <CardHeader id={`tasks-${section.key}`} title={`${section.title} (${formatNumber(section.tasks.length)})`} />
                  <ul className="divide-y divide-line">
                    {section.tasks.map((task) => (
                      <TaskRow
                        key={`${task.id}-${task.dueAt}-${task.ownerId}`}
                        orgId={orgId}
                        task={view(task, section.overdue === true)}
                        canEdit={canWrite}
                        showOwner={showAll}
                        assignees={assignees}
                      />
                    ))}
                  </ul>
                </Card>
              ))
          )}

          {groups.done.length > 0 ? (
            <Card aria-labelledby="tasks-done">
              <CardHeader id="tasks-done" title="הושלמו לאחרונה" />
              <ul className="divide-y divide-line">
                {groups.done.map((task) => (
                  <TaskRow
                    key={task.id}
                    orgId={orgId}
                    task={view(task, false)}
                    canEdit={canWrite}
                    showOwner={showAll}
                    assignees={assignees}
                  />
                ))}
              </ul>
            </Card>
          ) : null}
        </div>

        {canWrite ? (
          <Card aria-labelledby="new-task-title" className="lg:sticky lg:top-20">
            <CardHeader id="new-task-title" title="משימה חדשה" />
            <CardBody>
              <TaskForm orgId={orgId} assignees={assignees} myUserId={user.id} today={zoneDate(new Date())} />
            </CardBody>
          </Card>
        ) : null}
      </div>
    </>
  );
}

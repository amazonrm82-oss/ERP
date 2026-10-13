import Link from "next/link";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { paths } from "@/lib/paths";

import { sampleCounts } from "../checklist";
import type { SetupChecklist as Checklist } from "../queries";
import { ChecklistVisibilityButton } from "./checklist-visibility-button";
import { SampleDataControls } from "./sample-data-controls";
import { SetupChecklist } from "./setup-checklist";

type Props = { orgId: string; checklist: Checklist };

/** On the home page of owners and admins (USR-04) until they close it. */
export function SetupChecklistCard({ orgId, checklist }: Props) {
  const counts = sampleCounts(checklist.sample);
  return (
    <Card aria-labelledby="setup-checklist-title" className="mb-5">
      <CardHeader
        id="setup-checklist-title"
        title="רשימת הקמה"
        action={
          <ChecklistVisibilityButton orgId={orgId} hidden>
            הסתרה
          </ChecklistVisibilityButton>
        }
      />
      <CardBody className="space-y-4">
        <SetupChecklist items={checklist.items} labelledBy="setup-checklist-title" />
        <div className="border-t border-line pt-4">
          <SampleDataControls orgId={orgId} removable={counts.removable} kept={counts.kept} />
        </div>
        <p className="text-sm text-ink-soft">
          {"אפשר לחזור לרשימה גם מ"}
          <Link href={paths.settingsSetupChecklist(orgId)} className="text-accent-strong underline underline-offset-4">
            ההגדרות
          </Link>
          .
        </p>
      </CardBody>
    </Card>
  );
}

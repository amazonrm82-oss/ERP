import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { paths } from "@/lib/paths";

import { finishSetupAction } from "../actions";
import { SETUP_STEP_COUNT, setupStepTitle, type SetupStep } from "../steps";
import { StepActionButton } from "./step-action-button";

type Props = { orgId: string; step: SetupStep };

/** On the home page of owners and admins while the setup wizard is not finished: resume it, or close it. */
export function SetupResumeCard({ orgId, step }: Props) {
  return (
    <Card aria-labelledby="setup-resume-title" className="mb-5">
      <CardBody className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="setup-resume-title" className="font-semibold">
            הקמת העסק עוד לא הסתיימה
          </h2>
          <p className="text-sm text-ink-soft">
            {`שלב ${step} מתוך ${SETUP_STEP_COUNT}: ${setupStepTitle(step)}. אפשר לדלג על כל שלב.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ButtonLink href={paths.setup(orgId)} size="sm">
            להמשך ההקמה
          </ButtonLink>
          <StepActionButton action={finishSetupAction.bind(null, orgId)} variant="ghost" size="sm" pendingText="סוגרים…">
            לא צריך, תודה
          </StepActionButton>
        </div>
      </CardBody>
    </Card>
  );
}

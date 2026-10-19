"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveModulesAction } from "../actions";
import type { OrgModules } from "../modules";

// ORD-01: the orders switch shows only while the plan has the `orders` key
type Props = { orgId: string; modules: OrgModules; leadsLabel: string; ordersInPlan: boolean };

/** LEAD-08: the module switches, saved together. */
export function ModulesForm({ orgId, modules, leadsLabel, ordersInPlan }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveModulesAction.bind(null, orgId), null);
  const failed = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-5">
      <FormError message={failed?.message ?? null} />
      <FormNotice message={state?.ok ? state.message : null} />
      <Checkbox
        name="leads_enabled"
        defaultChecked={modules.leads}
        label={`מודול ${leadsLabel}`}
        hint="לעסק שעובד ישר עם אנשי קשר ועסקאות אפשר לכבות. כשהוא כבוי, הוא יורד מהתפריט ומהמסכים."
      />
      <Checkbox
        name="companies_enabled"
        defaultChecked={modules.companies}
        label="מודול החברות"
        hint="לעסק שמוכר לאנשים פרטיים אפשר לכבות. כשהוא כבוי, החברות יורדות מהתפריט, מהמסכים ומהטפסים."
      />
      {ordersInPlan ? (
        <>
          <input type="hidden" name="orders_shown" value="1" />
          <Checkbox
            name="orders_enabled"
            defaultChecked={modules.orders}
            label="מודול ההזמנות"
            hint="הזמנה נוצרת מהצעת מחיר שאושרה, מעסקה שנסגרה בהצלחה, או ידנית, ומקבלת מספר רץ. כבוי כברירת מחדל; כיבוי מסתיר את ההזמנות ולא מוחק אותן."
          />
        </>
      ) : null}
      <SubmitButton>שמירה</SubmitButton>
    </form>
  );
}

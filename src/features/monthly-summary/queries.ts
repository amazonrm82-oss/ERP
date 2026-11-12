import "server-only";

import { REPORT_SCHEMAS } from "@/features/reports/schemas";
import { serverLog } from "@/lib/log-server";
import { createClient } from "@/lib/supabase/server";

import { summaryLoadMessage, type MonthlySummary } from "./summary";

export type SummaryRead = { ok: true; value: MonthlySummary | null } | { ok: false; message: string };

/**
 * MNY-06: the month's counts (security invoker with the user's session: owners and admins only; anyone else gets
 * `value: null`). `month` is the first day of the month in the business's zone, null = this month. Never throws: a
 * database error (a statement timeout included), a failed call or an answer of the wrong shape (FXC-12) comes back as a
 * Hebrew line, logged with its code only, so the reports page still opens.
 */
export async function getMonthlySummary(orgId: string, month: string | null): Promise<SummaryRead> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("report_monthly_summary", { p_org: orgId, p_month: month });
    if (error) {
      await serverLog("error", "monthly_summary.read_failed", { org_id: orgId, code: error.code ?? "unknown" });
      return { ok: false, message: summaryLoadMessage(error) };
    }
    const parsed = REPORT_SCHEMAS.report_monthly_summary.safeParse(data);
    if (!parsed.success) {
      await serverLog("error", "report.shape_mismatch", { org_id: orgId, report: "report_monthly_summary" });
      return { ok: false, message: summaryLoadMessage(null) };
    }
    return { ok: true, value: parsed.data.allowed ? parsed.data : null };
  } catch {
    await serverLog("error", "monthly_summary.read_failed", { org_id: orgId, code: "exception" });
    return { ok: false, message: summaryLoadMessage(null) };
  }
}

import type { GraphLead } from "./graph/types";

/**
 * CAP-11: a Graph lead into what public.meta_lead_finish takes: the intake's own fields (name, phone, email, company),
 * every other answer as a "question: answer" line of the message, the platform ("fb" | "ig") and the campaign's name.
 * The database trims and cuts every value again; nothing else of the lead is sent.
 */
export type FinishLead = {
  full_name: string | null;
  phone: string | null;
  email: string | null;
  company_name: string | null;
  message: string | null;
  platform: "fb" | "ig";
  campaign: string | null;
};

const CONTROL = /[\u0000-\u001f\u007f]/g;
const clean = (value: string, max: number) => value.replace(CONTROL, " ").trim().slice(0, max).trim();

const KNOWN: Record<string, keyof FinishLead> = {
  full_name: "full_name",
  email: "email",
  phone_number: "phone",
  phone: "phone",
  company_name: "company_name",
};

export function finishLeadFrom(lead: GraphLead): FinishLead {
  const out: FinishLead = { full_name: null, phone: null, email: null, company_name: null, message: null, platform: lead.platform === "ig" ? "ig" : "fb", campaign: null };
  let first: string | null = null;
  let last: string | null = null;
  const lines: string[] = [];
  for (const field of Array.isArray(lead.field_data) ? lead.field_data.slice(0, 100) : []) {
    if (typeof field?.name !== "string" || !Array.isArray(field.values)) continue;
    const name = clean(field.name, 100);
    const value = clean(field.values.filter((v): v is string => typeof v === "string").join(", "), 1000);
    if (name === "" || value === "") continue;
    const key = KNOWN[name.toLowerCase()];
    if (key === "full_name" || key === "email" || key === "phone" || key === "company_name") {
      out[key] = out[key] ?? value.slice(0, key === "email" ? 254 : key === "phone" ? 40 : 200);
    } else if (name.toLowerCase() === "first_name") {
      first = value.slice(0, 100);
    } else if (name.toLowerCase() === "last_name") {
      last = value.slice(0, 100);
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  if (out.full_name === null && (first || last)) out.full_name = [first, last].filter(Boolean).join(" ");
  if (out.email !== null) out.email = out.email.toLowerCase();
  const message = lines.join("\n").slice(0, 5000).trim();
  out.message = message === "" ? null : message;
  out.campaign = typeof lead.campaign_name === "string" && clean(lead.campaign_name, 200) !== "" ? clean(lead.campaign_name, 200) : null;
  return out;
}

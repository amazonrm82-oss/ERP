// Route helpers, so URLs are built in one place.

export const paths = {
  home: "/",
  login: "/login",
  signup: "/signup",
  onboarding: "/onboarding",
  org: (orgId: string) => `/o/${orgId}`,
  leads: (orgId: string) => `/o/${orgId}/leads`,
  leadNew: (orgId: string) => `/o/${orgId}/leads/new`,
  lead: (orgId: string, leadId: string) => `/o/${orgId}/leads/${leadId}`,
  contacts: (orgId: string) => `/o/${orgId}/contacts`,
  contactNew: (orgId: string) => `/o/${orgId}/contacts/new`,
  contact: (orgId: string, contactId: string) => `/o/${orgId}/contacts/${contactId}`,
  companies: (orgId: string) => `/o/${orgId}/companies`,
  companyNew: (orgId: string) => `/o/${orgId}/companies/new`,
  company: (orgId: string, companyId: string) => `/o/${orgId}/companies/${companyId}`,
  deals: (orgId: string) => `/o/${orgId}/deals`,
  dealNew: (orgId: string) => `/o/${orgId}/deals/new`,
  deal: (orgId: string, dealId: string) => `/o/${orgId}/deals/${dealId}`,
  tasks: (orgId: string) => `/o/${orgId}/tasks`,
  settings: (orgId: string) => `/o/${orgId}/settings`,
  settingsUsers: (orgId: string) => `/o/${orgId}/settings/users`,
  settingsPipelines: (orgId: string) => `/o/${orgId}/settings/pipelines`,
  settingsLeads: (orgId: string) => `/o/${orgId}/settings/leads`,
  settingsFields: (orgId: string) => `/o/${orgId}/settings/fields`,
  settingsTags: (orgId: string) => `/o/${orgId}/settings/tags`,
  settingsTrash: (orgId: string) => `/o/${orgId}/settings/trash`,
  settingsTeams: (orgId: string) => `/o/${orgId}/settings/teams`,
  settingsTeam: (orgId: string, teamId: string) => `/o/${orgId}/settings/teams/${teamId}`,
  invite: (token: string) => `/invite/${token}`,
} as const;

// Only same-origin paths are accepted as a post-login destination; anything
// else (absolute URLs, protocol-relative "//host", backslashes) falls back to "/".
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) {
    return "/";
  }
  return next;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

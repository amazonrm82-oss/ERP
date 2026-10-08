// Route helpers, so URLs are built in one place.

export const paths = {
  home: "/",
  login: "/login",
  loginMfa: "/login/mfa",
  forgotPassword: "/forgot-password",
  resetPassword: "/reset-password",
  signup: "/signup",
  onboarding: "/onboarding",
  help: "/help",
  helpArticle: (slug: string) => `/help/${slug}`,
  legal: (doc: string) => `/legal/${doc}`,
  agreement: "/agreement",
  agreementSigned: "/agreement/signed",
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
  notifications: (orgId: string) => `/o/${orgId}/notifications`,
  file: (orgId: string, fileId: string) => `/o/${orgId}/files/${fileId}`,
  merge: (orgId: string, type: string, keep: string, merge?: string) =>
    `/o/${orgId}/merge?type=${type}&keep=${keep}${merge ? `&merge=${merge}` : ""}`,
  reports: (orgId: string) => `/o/${orgId}/reports`,
  report: (orgId: string, key: string) => `/o/${orgId}/reports/${key}`,
  settings: (orgId: string) => `/o/${orgId}/settings`,
  settingsUsers: (orgId: string) => `/o/${orgId}/settings/users`,
  transferRecords: (orgId: string, userId: string) => `/o/${orgId}/settings/users/${userId}/transfer`,
  settingsPipelines: (orgId: string) => `/o/${orgId}/settings/pipelines`,
  settingsLeads: (orgId: string) => `/o/${orgId}/settings/leads`,
  settingsFields: (orgId: string) => `/o/${orgId}/settings/fields`,
  settingsTags: (orgId: string) => `/o/${orgId}/settings/tags`,
  settingsIntake: (orgId: string) => `/o/${orgId}/settings/intake`,
  settingsIntakeItem: (orgId: string, formId: string) => `/o/${orgId}/settings/intake/${formId}`,
  settingsAutomations: (orgId: string) => `/o/${orgId}/settings/automations`,
  settingsAutomationNew: (orgId: string) => `/o/${orgId}/settings/automations/new`,
  settingsAutomation: (orgId: string, id: string) => `/o/${orgId}/settings/automations/${id}`,
  settingsAutomationEdit: (orgId: string, id: string) => `/o/${orgId}/settings/automations/${id}/edit`,
  imports: (orgId: string) => `/o/${orgId}/settings/import`,
  importNew: (orgId: string) => `/o/${orgId}/settings/import/new`,
  settingsAudit: (orgId: string) => `/o/${orgId}/settings/audit`,
  settingsAccount: (orgId: string) => `/o/${orgId}/settings/account`,
  settingsTrash: (orgId: string) => `/o/${orgId}/settings/trash`,
  settingsTeams: (orgId: string) => `/o/${orgId}/settings/teams`,
  settingsTeam: (orgId: string, teamId: string) => `/o/${orgId}/settings/teams/${teamId}`,
  invite: (token: string) => `/invite/${token}`,
  admin: "/admin",
  adminOrgs: "/admin/orgs",
  adminOrg: (orgId: string) => `/admin/orgs/${orgId}`,
  adminPlans: "/admin/plans",
  adminStaff: "/admin/staff",
  adminUsers: "/admin/users",
  adminLog: "/admin/log",
} as const;

// Only same-origin paths are accepted as a post-login destination; anything
// else (absolute URLs, protocol-relative "//host", backslashes, control
// characters) falls back to "/". The target is parsed as a URL against a
// stand-in origin and must stay on it (FXS-01).
const SAME_SITE = "http://same-site.invalid";
// control characters (browsers drop tabs and newlines from URLs) and backslashes (read as slashes)
const UNSAFE_IN_PATH = /[\u0000-\u001f\u007f\\]/;

export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || UNSAFE_IN_PATH.test(next)) {
    return "/";
  }
  let url: URL;
  try {
    url = new URL(next, SAME_SITE);
  } catch {
    return "/";
  }
  if (url.origin !== SAME_SITE) {
    return "/";
  }
  // only the path, query and fragment, as the URL parser normalised them ("/.//x" becomes "//x")
  const path = `${url.pathname}${url.search}${url.hash}`;
  return path.startsWith("//") ? "/" : path;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

// SPD-07: the site widget's pages. The public ones sit under the proxy's public prefixes (/f/, /api/forms/).
export const siteWidgetSettingsPath = (orgId: string) => `/o/${orgId}/settings/site-widget`;
/** The one line the business puts on its website loads this script. */
export const widgetScriptPath = (token: string) => `/f/w/${token}.js`;
/** The short form, opened by the script in a frame on the business's website. */
export const widgetFormPath = (token: string) => `/f/widget/${token}`;
export const widgetSubmitPath = (token: string) => `/api/forms/widget/${token}`;

const TOKEN = /^[0-9a-f]{32}$/;
export function isWidgetToken(token: string): boolean {
  return TOKEN.test(token);
}
/** The token of a script file name "<token>.js", or null. */
export function widgetScriptToken(file: string): string | null {
  const match = /^([0-9a-f]{32})\.js$/.exec(file);
  return match ? match[1] : null;
}

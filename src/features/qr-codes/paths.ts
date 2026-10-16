// BIZ-03: the QR codes' pages. The scan route sits under the proxy's public prefix /f/.
export const qrCodesSettingsPath = (orgId: string) => `/o/${orgId}/settings/qr-codes`;
export const qrScanPath = (token: string) => `/f/q/${token}`;

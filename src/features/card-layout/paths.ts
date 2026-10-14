import type { CardLayoutType } from "./layout";

// FLD-08 page. Kept here rather than in src/lib/paths.ts (shared); the lead may move it there when merging.
export const cardLayoutSettingsPath = (orgId: string, type?: CardLayoutType) =>
  `/o/${orgId}/settings/card-layout${type && type !== "lead" ? `?type=${type}` : ""}`;

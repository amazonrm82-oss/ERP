export const TAGGABLE = ["lead", "contact", "company", "deal"] as const;
export type Taggable = (typeof TAGGABLE)[number];

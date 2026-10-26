"use client";

import { useCallback } from "react";

import { SearchPicker, type SearchPickerChoice } from "@/components/ui/search-picker";

import { searchRecordLinkAction } from "../record-link-actions";
import type { LinkTarget } from "../types";

type Props = {
  orgId: string;
  target: LinkTarget;
  name: string;
  label: string;
  initial: SearchPickerChoice;
  hint?: string;
  error?: string;
  required?: boolean;
};

const PLACEHOLDERS: Record<LinkTarget, string> = {
  lead: "הקלידו שם, טלפון או אימייל",
  contact: "הקלידו שם, טלפון או אימייל",
  company: "הקלידו שם חברה",
  deal: "הקלידו שם עסקה",
};

/** FLD-06 part B: pick the one record a record link field points at, searched on the server with the user's session. */
export function RecordLinkPicker({ orgId, target, ...props }: Props) {
  const search = useCallback((query: string) => searchRecordLinkAction(orgId, target, query), [orgId, target]);
  return <SearchPicker {...props} placeholder={PLACEHOLDERS[target]} search={search} />;
}

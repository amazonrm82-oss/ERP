"use client";

import { useCallback } from "react";

import { SearchPicker, type SearchPickerChoice } from "@/components/ui/search-picker";

import { searchContactsAction } from "../picker-actions";

type Props = {
  orgId: string;
  name: string;
  label: string;
  hideLabel?: boolean;
  initial: SearchPickerChoice;
  // ids the form cannot take (a deal's linked contacts, the contact itself)
  exclude?: string[];
  hint?: string;
  error?: string;
  required?: boolean;
  clearable?: boolean;
  onChange?: (choice: SearchPickerChoice) => void;
  className?: string;
};

/** Pick a contact by name, phone or email, searched on the server with the user's session (SearchPicker). */
export function ContactPicker({ orgId, exclude, ...props }: Props) {
  const excludeKey = (exclude ?? []).join(",");
  const search = useCallback(
    (query: string) => searchContactsAction(orgId, query, excludeKey === "" ? [] : excludeKey.split(",")),
    [orgId, excludeKey],
  );
  return <SearchPicker {...props} search={search} />;
}

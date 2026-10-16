// FXA-09: the global search opens only with Ctrl+K or Cmd+K. A one-key shortcut ("/") cannot be turned off and fires
// for people who type by voice or with a switch (WCAG 2.1.4 Character Key Shortcuts).
export function isSearchShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): boolean {
  return (event.key === "k" || event.key === "K") && (event.ctrlKey || event.metaKey) && !event.altKey;
}

/** The id every public page gives its <main>, so the skip link has one target (WEB-04). */
export const MAIN_CONTENT_ID = "main";

/**
 * WEB-04 (WCAG 2.4.1, IS 5568): "דילוג לתוכן", the first stop of the keyboard on the public site's pages. Hidden until it is
 * focused, so it never shows for a mouse or in a screenshot; the same look as the business frame's own skip link.
 */
export function SkipLink() {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:text-ink focus:shadow"
    >
      דילוג לתוכן
    </a>
  );
}

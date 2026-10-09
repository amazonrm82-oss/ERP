import { buttonClasses } from "@/components/ui/button";

type Props = {
  // the export route with the list's current query, without the format
  href: (format: "csv" | "xlsx") => string;
};

/** "Export" above a list (LST-08): the list as it is filtered, as CSV or Excel. */
export function ExportMenu({ href }: Props) {
  return (
    <details className="relative">
      <summary className={buttonClasses("secondary", "md", "cursor-pointer list-none [&::-webkit-details-marker]:hidden")}>ייצוא</summary>
      <div className="max-sm:fixed max-sm:inset-x-2 max-sm:top-16 max-sm:mt-0 max-sm:w-auto max-sm:max-h-[calc(100dvh-10rem)] max-sm:overflow-y-auto sm:absolute sm:end-0 z-20 mt-2 w-56 rounded-lg border border-line bg-surface p-1 shadow-lg">
        <p className="px-3 py-1.5 text-sm text-ink-soft">הרשימה לפי הסינון, בעמודות שבטבלה.</p>
        <a href={href("xlsx")} download className="block rounded-md px-3 py-2 hover:bg-canvas focus-visible:bg-canvas">
          קובץ Excel
        </a>
        <a href={href("csv")} download className="block rounded-md px-3 py-2 hover:bg-canvas focus-visible:bg-canvas">
          קובץ CSV
        </a>
      </div>
    </details>
  );
}

/** The export address for the list's current query string (`a=1&b=2`, maybe empty). */
export function exportHref(listPath: string, listHref: string) {
  const query = listHref.includes("?") ? listHref.slice(listHref.indexOf("?") + 1) : "";
  return (format: "csv" | "xlsx") => `${listPath}/export?${query ? `${query}&` : ""}format=${format}`;
}

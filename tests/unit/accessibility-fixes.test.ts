import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Table } from "@/components/ui/table";
import { isSearchShortcut } from "@/features/search/shortcut";

// FXA-09: the small accessibility fixes that can be checked without a browser.

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".tsx") ? [path] : [];
  });
}

/** The element that holds a `_blank` target: from its opening tag to its closing tag. */
function elementAt(source: string, at: number): string {
  const start = source.lastIndexOf("<", at);
  const tag = /^<([A-Za-z]+)/.exec(source.slice(start))?.[1] ?? "";
  const end = source.indexOf(`</${tag}>`, at);
  return source.slice(start, end === -1 ? undefined : end);
}

describe("FXA-09 accessibility fixes", () => {
  it("the global search opens only with Ctrl+K or Cmd+K, never with a single key", () => {
    const key = (k: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey", boolean>> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });
    expect(isSearchShortcut(key("k", { ctrlKey: true }))).toBe(true);
    expect(isSearchShortcut(key("K", { metaKey: true }))).toBe(true);
    for (const event of [key("/"), key("k"), key("/", { ctrlKey: true }), key("k", { ctrlKey: true, altKey: true })]) {
      expect(isSearchShortcut(event), JSON.stringify(event)).toBe(false);
    }
  });

  it("a table that scrolls sideways is a named region the keyboard can reach", () => {
    const html = renderToStaticMarkup(Table({ caption: "לידים", children: createElement("tbody") }));
    expect(html).toMatch(/<div role="region" aria-label="לידים" tabindex="0"/);
  });

  it("the base font size is relative, so the reader's own browser setting counts", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    const html = /\nhtml \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(html).toMatch(/font-size:\s*100%/);
    expect(html).not.toMatch(/font-size:\s*\d+px/);
  });

  it("every link that opens a new tab says so to screen readers", () => {
    const missing: string[] = [];
    for (const file of sourceFiles(join(process.cwd(), "src"))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/target=(?:"_blank"|\{[^}]*"_blank"[^}]*\})/g)) {
        if (!elementAt(source, match.index).includes("נפתח בחלון חדש")) {
          missing.push(`${file.slice(process.cwd().length + 1)}:${source.slice(0, match.index).split("\n").length}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createFocusRescue, firstFocusable, focusIsLost, focusLanding, isFocusable, rowOf, setDialogLanding, type FocusNode } from "@/lib/focus-rescue";

// FXA-08: a small fake page (no browser in the unit tests). An element is on the page while its top ancestor is the
// document's <html>; focus() records itself as the active element, like the browser does.
class El implements FocusNode {
  parentElement: El | null = null;
  readonly kids: El[] = [];
  private attrs = new Map<string, string>();
  constructor(
    readonly page: Page,
    readonly tagName: string,
    attrs: Record<string, string> = {},
  ) {
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
  }
  get children() {
    return this.kids;
  }
  get nextElementSibling(): El | null {
    const list = this.parentElement?.kids;
    return list ? (list[list.indexOf(this) + 1] ?? null) : null;
  }
  get previousElementSibling(): El | null {
    const list = this.parentElement?.kids;
    return list ? (list[list.indexOf(this) - 1] ?? null) : null;
  }
  get isConnected(): boolean {
    if (this.page.html === this) return true;
    let top: El | null = this.parentElement;
    if (!top) return false;
    while (top.parentElement) top = top.parentElement;
    return top === this.page.html;
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attrs.has(name);
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
  }
  focus() {
    // like the browser: only an element on the page that can take focus
    if (this.isConnected && !this.hasAttribute("disabled")) this.page.active = this;
  }
  add(...kids: El[]): this {
    for (const kid of kids) {
      kid.parentElement = this;
      this.kids.push(kid);
    }
    return this;
  }
  remove() {
    const list = this.parentElement?.kids;
    if (list) list.splice(list.indexOf(this), 1);
    this.parentElement = null;
  }
}

class Page {
  readonly html: El;
  readonly body: El;
  active: El | null = null;
  constructor() {
    this.html = new El(this, "HTML");
    this.body = new El(this, "BODY");
    this.html.add(this.body);
    this.active = this.body;
  }
  el(tag: string, attrs: Record<string, string> = {}, ...kids: El[]) {
    return new El(this, tag, attrs).add(...kids);
  }
}

/** A page with a heading and a list of three rows, each with a link and a delete button. */
function listPage() {
  const page = new Page();
  const rows = ["א", "ב", "ג"].map((name) => {
    const link = page.el("A", { href: `/r/${name}` });
    const del = page.el("BUTTON");
    return { row: page.el("LI", {}, link, del), link, del };
  });
  const h1 = page.el("H1");
  const list = page.el("UL", {}, ...rows.map((r) => r.row));
  const main = page.el("MAIN", {}, h1, list);
  page.body.add(main);
  return { page, rows, h1, list, main };
}

describe("FXA-08 focusable elements", () => {
  it("knows what a person can tab to", () => {
    const page = new Page();
    expect(isFocusable(page.el("BUTTON"))).toBe(true);
    expect(isFocusable(page.el("BUTTON", { disabled: "" }))).toBe(false);
    expect(isFocusable(page.el("A"))).toBe(false);
    expect(isFocusable(page.el("A", { href: "/" }))).toBe(true);
    expect(isFocusable(page.el("INPUT", { type: "hidden" }))).toBe(false);
    expect(isFocusable(page.el("DIV", { tabindex: "0" }))).toBe(true);
    expect(isFocusable(page.el("BUTTON", { tabindex: "-1" }))).toBe(false);
    expect(isFocusable(page.el("BUTTON", { hidden: "" }))).toBe(false);
    expect(firstFocusable(page.el("DIV", {}, page.el("SPAN"), page.el("DIV", { "aria-hidden": "true" }, page.el("BUTTON")), page.el("SELECT")))?.tagName).toBe("SELECT");
  });

  it("finds the row: a list item, a table row or a marked item, never past a window", () => {
    const page = new Page();
    const button = page.el("BUTTON");
    const tr = page.el("TR", {}, page.el("TD", {}, button));
    expect(rowOf(button)).toBe(tr);
    const inCard = page.el("BUTTON");
    const card = page.el("DIV", { "data-focus-item": "" }, inCard);
    expect(rowOf(inCard)).toBe(card);
    const inDialog = page.el("BUTTON");
    page.el("LI", {}, page.el("DIALOG", {}, inDialog));
    expect(rowOf(inDialog)).toBeNull();
  });
});

describe("FXA-08 where focus lands", () => {
  it("a deleted row: the next row, else the previous one, else the page's heading", () => {
    const { rows, h1 } = listPage();
    const middle = focusLanding(rows[1].del);
    rows[1].row.remove();
    expect(middle()).toBe(rows[2].link);

    const last = focusLanding(rows[2].del);
    rows[2].row.remove();
    expect(last()).toBe(rows[0].link);

    const only = focusLanding(rows[0].del);
    rows[0].row.remove();
    expect(only()).toBe(h1);
    // the heading takes focus without joining the tab order
    expect(h1.getAttribute("tabindex")).toBe("-1");
  });

  it("skips rows with nothing to focus", () => {
    const { page, rows, list } = listPage();
    const empty = page.el("LI", {}, page.el("SPAN"));
    list.kids.splice(1, 0, empty);
    empty.parentElement = list;
    const landing = focusLanding(rows[0].del);
    rows[0].row.remove();
    expect(landing()).toBe(rows[1].link);
  });

  it("without a heading: the main area", () => {
    const { rows, main, h1 } = listPage();
    h1.remove();
    rows.forEach((r) => r.row.remove());
    const page = rows[0].row.page;
    const button = page.el("BUTTON");
    main.add(button);
    const landing = focusLanding(button);
    button.remove();
    expect(landing()).toBe(main);
  });

  it("inside an open window it stays in the window; once the window is gone, the opener's row decides", () => {
    const { page, rows } = listPage();
    const cancel = page.el("BUTTON");
    const confirm = page.el("BUTTON");
    const dialog = page.el("DIALOG", { open: "" }, cancel, confirm);
    page.body.add(dialog);
    setDialogLanding(dialog, focusLanding(rows[1].del));

    const whileOpen = focusLanding(confirm);
    confirm.remove();
    expect(whileOpen()).toBe(cancel);

    // the row that opened it is deleted together with the window
    const gone = focusLanding(cancel);
    rows[1].row.remove();
    dialog.remove();
    expect(gone()).toBe(rows[2].link);
  });

  it("focus is lost on nothing, on the page itself, or on an element that left the page", () => {
    const { page, rows } = listPage();
    expect(focusIsLost(null, page.body)).toBe(true);
    expect(focusIsLost(page.body, page.body)).toBe(true);
    expect(focusIsLost(rows[0].link, page.body)).toBe(false);
    rows[0].row.remove();
    expect(focusIsLost(rows[0].link, page.body)).toBe(true);
  });
});

describe("FXA-08 the page-wide net", () => {
  function net(page: Page) {
    return createFocusRescue({ activeElement: () => page.active, body: page.body });
  }

  it("moves focus to the next row when the focused button's row is deleted", () => {
    const { page, rows } = listPage();
    const rescue = net(page);
    rows[0].del.focus();
    rescue.focusIn(rows[0].del);
    rows[0].row.remove();
    rescue.changed();
    expect(page.active).toBe(rows[1].link);
  });

  it("never takes focus a person moved elsewhere", () => {
    const { page, rows } = listPage();
    const rescue = net(page);
    rows[0].del.focus();
    rescue.focusIn(rows[0].del);
    rows[2].link.focus();
    rows[0].row.remove();
    rescue.changed();
    expect(page.active).toBe(rows[2].link);
  });

  it("does nothing while the focused element is still there", () => {
    const { page, rows } = listPage();
    const rescue = net(page);
    rows[1].del.focus();
    rescue.focusIn(rows[1].del);
    rows[0].row.remove();
    rescue.changed();
    expect(page.active).toBe(rows[1].del);
  });

  it("gives focus back to a button that was disabled while its action ran", () => {
    const { page, rows } = listPage();
    const rescue = net(page);
    const button = rows[0].del;
    button.focus();
    rescue.focusIn(button);
    // the browser drops focus to the page when the focused button is disabled
    button.setAttribute("disabled", "");
    page.active = page.body;
    rescue.changed();
    button.removeAttribute("disabled");
    rescue.changed();
    expect(page.active).toBe(button);
  });

  it("also when the browser keeps focus on the disabled button until it is enabled", () => {
    const { page, rows } = listPage();
    const rescue = net(page);
    const button = rows[0].del;
    button.focus();
    rescue.focusIn(button);
    button.setAttribute("disabled", "");
    rescue.changed();
    page.active = page.body;
    button.removeAttribute("disabled");
    rescue.changed();
    expect(page.active).toBe(button);
  });

  it("does not pull focus back to a re-enabled button after a person moved on", () => {
    const { page, rows } = listPage();
    const rescue = net(page);
    const button = rows[0].del;
    button.focus();
    rescue.focusIn(button);
    button.setAttribute("disabled", "");
    page.active = page.body;
    rescue.changed();
    rows[1].link.focus();
    rescue.focusIn(rows[1].link);
    button.removeAttribute("disabled");
    rescue.changed();
    expect(page.active).toBe(rows[1].link);
  });

  it("does not move focus to a button that was never focused when it is enabled", () => {
    const { page, rows } = listPage();
    const rescue = net(page);
    rows[0].del.setAttribute("disabled", "");
    rescue.changed();
    rows[0].del.removeAttribute("disabled");
    rescue.changed();
    expect(page.active).toBe(page.body);
  });
});

describe("FXA-08 wiring", () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

  it("the net is mounted once, in the root layout", () => {
    expect(read("src/app/layout.tsx")).toMatch(/<FocusRescue \/>/);
    expect(read("src/components/focus-rescue.tsx")).toMatch(/attributeFilter: \["disabled"\]/);
  });

  it("Dialog remembers the opener's row and falls back to it", () => {
    const dialog = read("src/components/ui/dialog.tsx");
    expect(dialog).toMatch(/setDialogLanding\(dialog, landing\)/);
    expect(dialog).toMatch(/restoreFocus\(opener, dialog, landing\)/);
  });

  it("ActionButton gives focus back to its button when the question goes away", () => {
    const button = read("src/components/action-button.tsx");
    expect(button).toMatch(/ref=\{mainRef\}/);
    expect(button).toMatch(/if \(wasAsking\.current && !asking\) returnFocus\(mainRef\.current\)/);
  });
});

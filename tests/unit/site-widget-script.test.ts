import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { campaignOnlyUrl, collectAttribution } from "@/features/intake/attribution";
import { embedSnippet } from "@/features/site-widgets/model";
import { isWidgetToken, widgetScriptToken } from "@/features/site-widgets/paths";
import { publicWidgetFrom } from "@/features/site-widgets/public";
import { widgetScript, type WidgetScriptSettings } from "@/features/site-widgets/script";

type Listener = (event: { key?: string }) => void;
type FakeNode = {
  tag: string;
  style: Record<string, string>;
  attrs: Record<string, string>;
  children: FakeNode[];
  parentNode: FakeNode | null;
  textContent: string;
  listeners: Record<string, Listener[]>;
  [key: string]: unknown;
};

const TOKEN = "0123456789abcdef0123456789abcdef";
const SETTINGS: WidgetScriptSettings = {
  label: "דברו איתנו",
  position: "left",
  whatsapp: "97235551234",
  call: "+97235551234",
  formPath: `/f/widget/${TOKEN}`,
  accent: "#1e56d6",
  onAccent: "#ffffff",
};

/** Runs the served script the way a browser would, in a page that records what it touches. */
function runScript(script: string, pageHref = "https://shop.example/sale?utm_source=facebook&session=abc#top", scriptSrc = `https://crm.example/f/w/${TOKEN}.js`) {
  const page = new URL(pageHref);
  const touched: string[] = [];
  const byId: Record<string, FakeNode> = {};
  const docListeners: Record<string, Listener[]> = {};
  let focused: FakeNode | null = null;
  const node = (tag: string): FakeNode => {
    const n: FakeNode = {
      tag,
      style: {},
      attrs: {},
      children: [],
      parentNode: null,
      textContent: "",
      listeners: {},
      setAttribute(name: string, value: string) {
        n.attrs[name] = value;
      },
      getAttribute(name: string) {
        return name in n.attrs ? n.attrs[name] : null;
      },
      appendChild(child: FakeNode) {
        child.parentNode = n;
        n.children.push(child);
        if (typeof child.id === "string") byId[child.id] = child;
        return child;
      },
      removeChild(child: FakeNode) {
        n.children = n.children.filter((c) => c !== child);
        child.parentNode = null;
        return child;
      },
      addEventListener(type: string, fn: Listener) {
        (n.listeners[type] ??= []).push(fn);
      },
      focus() {
        focused = n;
      },
    };
    Object.defineProperty(n, "firstChild", { get: () => n.children[0] ?? null });
    return n;
  };
  const body = node("body");
  const forbidden = (name: string) => ({
    get() {
      touched.push(name);
      throw new Error(`touched ${name}`);
    },
    set() {
      touched.push(name);
      throw new Error(`touched ${name}`);
    },
  });
  const document = {
    currentScript: { src: scriptSrc },
    body,
    createElement: (tag: string) => node(tag),
    getElementById: (id: string) => byId[id] ?? null,
    addEventListener: (type: string, fn: Listener) => {
      (docListeners[type] ??= []).push(fn);
    },
  };
  Object.defineProperty(document, "cookie", forbidden("document.cookie"));
  const window = { location: { href: page.href, origin: page.origin, pathname: page.pathname, search: page.search } };
  for (const name of ["localStorage", "sessionStorage", "indexedDB", "navigator", "fetch", "XMLHttpRequest"]) {
    Object.defineProperty(window, name, forbidden(name));
  }
  const context: Record<string, unknown> = { URL, URLSearchParams, window, document };
  for (const name of ["localStorage", "sessionStorage", "indexedDB", "navigator", "fetch", "XMLHttpRequest"]) {
    Object.defineProperty(context, name, forbidden(name));
  }
  vm.runInNewContext(script, context);
  const all = (n: FakeNode): FakeNode[] => [n, ...n.children.flatMap(all)];
  return {
    body,
    touched,
    nodes: () => all(body),
    press: (key: string) => (docListeners.keydown ?? []).forEach((fn) => fn({ key })),
    focused: () => focused,
    rerun: () => vm.runInNewContext(script, context),
  };
}

const click = (n: FakeNode) => (n.listeners.click ?? []).forEach((fn) => fn({}));

describe("SPD-07: the site widget's script", () => {
  it("draws a floating button with WhatsApp, a call and the short form, in the business's colour", () => {
    const page = runScript(widgetScript(SETTINGS));
    const root = page.body.children[0];
    expect(root.id).toBe("mx-site-widget");
    expect(root.style).toMatchObject({ position: "fixed", left: "16px" });
    const launcher = page.nodes().find((n) => n.tag === "button" && n.textContent === "דברו איתנו")!;
    expect(launcher.style).toMatchObject({ background: "#1e56d6", color: "#ffffff" });
    expect(launcher.attrs["aria-expanded"]).toBe("false");
    click(launcher);
    expect(launcher.attrs["aria-expanded"]).toBe("true");
    const links = page.nodes().filter((n) => n.tag === "a");
    expect(links.map((n) => [n.textContent, n.href])).toEqual([
      ["WhatsApp", "https://wa.me/97235551234"],
      ["חיוג", "tel:+97235551234"],
    ]);
    expect(links[0].rel).toBe("noopener noreferrer");
    // nothing the page holds about the visitor was read or written
    expect(page.touched).toEqual([]);
  });

  it("the form opens in a frame of this app, with the host page's campaign keys and address only", () => {
    const host = "https://shop.example/sale?utm_source=facebook&session=abc&utm_campaign=%D7%97%D7%95%D7%A8%D7%A3&email=a%40b.co#top";
    const page = runScript(widgetScript(SETTINGS), host);
    const formButton = page.nodes().find((n) => n.tag === "button" && n.textContent === "השאירו פרטים")!;
    click(formButton);
    const frame = page.nodes().find((n) => n.tag === "iframe")!;
    const src = new URL(String(frame.src));
    expect(src.origin + src.pathname).toBe(`https://crm.example/f/widget/${TOKEN}`);
    expect([...src.searchParams.keys()]).toEqual(["embed", "utm_source", "utm_campaign", "page_url"]);
    expect(src.searchParams.get("page_url")).toBe(campaignOnlyUrl(host));
    // what the form then reads from its own address
    expect(collectAttribution(src.href, "https://shop.example/")).toMatchObject({ utm_source: "facebook", utm_campaign: "חורף", landing_url: campaignOnlyUrl(host) });
    // the close button gets the focus; Escape closes and gives it back to the button
    const dialog = page.nodes().find((n) => n.attrs.role === "dialog")!;
    expect(page.focused()?.textContent).toBe("סגירה");
    page.press("Escape");
    expect(dialog.parentNode).toBeNull();
    expect(page.focused()?.textContent).toBe("דברו איתנו");
    expect(page.touched).toEqual([]);
  });

  it("text goes in as text: a value cannot close the script or add markup", () => {
    const script = widgetScript({ ...SETTINGS, label: "</script><img src=x onerror=alert(1)>" });
    expect(script).not.toContain("</script>");
    const page = runScript(script);
    expect(page.nodes().some((n) => n.textContent === "</script><img src=x onerror=alert(1)>")).toBe(true);
    expect(page.nodes().some((n) => n.tag === "img")).toBe(false);
  });

  it("shows only the choices that are on, draws nothing with none, and never twice on a page", () => {
    const onlyForm = runScript(widgetScript({ ...SETTINGS, whatsapp: null, call: null }));
    expect(onlyForm.nodes().filter((n) => n.tag === "a")).toEqual([]);
    const none = runScript(widgetScript({ ...SETTINGS, whatsapp: null, call: null, formPath: null }));
    expect(none.body.children).toEqual([]);
    const page = runScript(widgetScript({ ...SETTINGS, position: "right" }));
    expect(page.body.children[0].style.right).toBe("16px");
    page.rerun();
    expect(page.body.children).toHaveLength(1);
  });

  it("reads only display settings from the database's answer", () => {
    expect(
      publicWidgetFrom({ label: "צרו קשר", position: "right", business: "עסק", brand: { color: "#112233" }, built_with: true, whatsapp: "97235551234", call: "+97235551234", form: true }),
    ).toEqual({
      label: "צרו קשר",
      position: "right",
      business: "עסק",
      brand: { logoPath: null, color: "#112233" },
      builtWith: true,
      whatsapp: "97235551234",
      call: "+97235551234",
      form: true,
    });
    const odd = publicWidgetFrom({ label: "x", business: "y", position: "top", brand: { color: "red" }, whatsapp: "javascript:alert(1)", call: "tel:1", form: "yes" })!;
    expect(odd).toMatchObject({ position: "left", brand: { color: null }, whatsapp: null, call: null, form: false });
    expect(publicWidgetFrom({ business: "y" })).toBeNull();
    expect(publicWidgetFrom(null)).toBeNull();
  });

  it("tokens and the embed line", () => {
    expect(widgetScriptToken(`${TOKEN}.js`)).toBe(TOKEN);
    for (const file of [TOKEN, `${TOKEN}.json`, `../${TOKEN}.js`, `${TOKEN.toUpperCase()}.js`]) expect(widgetScriptToken(file), file).toBeNull();
    expect(isWidgetToken(TOKEN)).toBe(true);
    expect(isWidgetToken(`${TOKEN}x`)).toBe(false);
    expect(embedSnippet(`https://crm.example/f/w/${TOKEN}.js`)).toBe(`<script src="https://crm.example/f/w/${TOKEN}.js" async></script>`);
  });
});

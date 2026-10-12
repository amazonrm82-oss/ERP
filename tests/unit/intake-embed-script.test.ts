import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { campaignOnlyUrl, collectAttribution } from "@/features/intake/attribution";
import { EMBED_SCRIPT } from "@/features/intake/embed-script";

type FakeFrame = {
  src: string;
  attrs: Record<string, string>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
};

function frame(src: string): FakeFrame {
  const f: FakeFrame = {
    src,
    attrs: { src },
    getAttribute(name) {
      return name in f.attrs ? f.attrs[name] : null;
    },
    setAttribute(name, value) {
      f.attrs[name] = value;
    },
  };
  return f;
}

/** Runs the served script the way a browser would, on a host page with these iframes. */
function runScript(pageHref: string, frames: FakeFrame[], scriptSrc = "https://crm.example/f/embed.js") {
  const page = new URL(pageHref);
  const context = {
    URL,
    URLSearchParams,
    window: { location: { href: page.href, origin: page.origin, pathname: page.pathname, search: page.search } },
    document: {
      currentScript: { src: scriptSrc },
      baseURI: page.href,
      getElementsByTagName: (tag: string) => (tag === "iframe" ? frames : []),
    },
  };
  vm.runInNewContext(EMBED_SCRIPT, context);
  return frames;
}

describe("CAP-02: the embed script passes only campaign details and the page address", () => {
  it("adds the host page's campaign parameters and its campaign-only address to the form", () => {
    const host = "https://shop.co.il/sale?utm_source=facebook&session=abc&utm_campaign=%D7%97%D7%95%D7%A8%D7%A3&fbclid=F1&email=a%40b.co#top";
    const [f] = runScript(host, [frame("https://crm.example/f/tok123?embed=1")]);
    const src = new URL(f.src);
    expect(src.origin + src.pathname).toBe("https://crm.example/f/tok123");
    expect([...src.searchParams.keys()]).toEqual(["embed", "utm_source", "utm_campaign", "fbclid", "page_url"]);
    expect(src.searchParams.get("utm_campaign")).toBe("חורף");
    expect(src.searchParams.get("page_url")).toBe("https://shop.co.il/sale?utm_source=facebook&utm_campaign=%D7%97%D7%95%D7%A8%D7%A3&fbclid=F1");
    expect(src.searchParams.get("page_url")).toBe(campaignOnlyUrl(host));
    expect(f.attrs["data-lead-form"]).toBe("1");
    // what the form then reads from its own address
    expect(collectAttribution(f.src, "https://shop.co.il/")).toEqual({
      utm_source: "facebook",
      utm_campaign: "חורף",
      fbclid: "F1",
      landing_url: "https://shop.co.il/sale?utm_source=facebook&utm_campaign=%D7%97%D7%95%D7%A8%D7%A3&fbclid=F1",
    });
  });

  it("leaves other iframes, other origins and forms opened without embed=1 alone", () => {
    const frames = [
      frame("https://www.youtube.com/embed/x"),
      frame("https://evil.example/f/tok123?embed=1"),
      frame("https://crm.example/f/tok123"),
      frame("https://crm.example/o/abc?embed=1"),
    ];
    const before = frames.map((f) => f.src);
    runScript("https://shop.co.il/?utm_source=x", frames);
    expect(frames.map((f) => f.src)).toEqual(before);
  });

  it("does not override what the embed code already says, and runs once per frame", () => {
    const [f] = runScript("https://shop.co.il/?utm_source=host&utm_medium=cpc", [frame("https://crm.example/f/t?embed=1&utm_source=mine")]);
    const src = new URL(f.src);
    expect(src.searchParams.get("utm_source")).toBe("mine");
    expect(src.searchParams.get("utm_medium")).toBe("cpc");
    const again = f.src;
    runScript("https://shop.co.il/?utm_source=host&utm_term=t", [f]);
    expect(f.src).toBe(again);
  });

  it("never passes the user info of the host page's address", () => {
    const [f] = runScript("https://user:pass@shop.co.il/sale?utm_source=fb&x=1#top", [frame("https://crm.example/f/t?embed=1")]);
    const pageUrl = new URL(f.src).searchParams.get("page_url");
    expect(pageUrl).toBe("https://shop.co.il/sale?utm_source=fb");
    expect(f.src).not.toContain("pass");
  });

  it("cuts long values and skips a page address over the limit", () => {
    const long = "a".repeat(3000);
    const [f] = runScript(`https://shop.co.il/?utm_content=${long}`, [frame("https://crm.example/f/t?embed=1")]);
    const src = new URL(f.src);
    expect(src.searchParams.get("utm_content")).toHaveLength(500);
    expect(src.searchParams.has("page_url")).toBe(false);
  });

  it("does nothing without its own script element (old browsers, inline copies)", () => {
    const page = new URL("https://shop.co.il/?utm_source=x");
    const frames = [frame("https://crm.example/f/t?embed=1")];
    vm.runInNewContext(EMBED_SCRIPT, {
      URL,
      URLSearchParams,
      window: { location: { href: page.href, origin: page.origin, pathname: page.pathname, search: page.search } },
      document: { currentScript: null, baseURI: page.href, getElementsByTagName: () => frames },
    });
    expect(frames[0].src).toBe("https://crm.example/f/t?embed=1");
  });

  it("the script's copy of the address rule matches campaignOnlyUrl()", () => {
    const cases = [
      "https://a.co/",
      "https://a.co/p?x=1",
      "https://a.co/p?x=1#h",
      "https://a.co/p?utm_source=a&&x=1&gclid=G&utm_source=b",
      "https://a.co/p#h?utm_source=a",
      "https://a.co/p?utm_source&ctwa_clid=C1&utm_sourcex=1",
      "https://a.co/p?UTM_SOURCE=a&utm_medium=b",
      "https://user:pass@a.co/p?utm_source=a&x=1",
      "https://user@a.co:8443/p?gclid=G",
    ];
    for (const href of cases) {
      const [f] = runScript(href, [frame("https://crm.example/f/t?embed=1")]);
      expect(new URL(f.src).searchParams.get("page_url"), href).toBe(campaignOnlyUrl(href));
    }
    // the script's own copy of the rule, on text a browser would never give it as location
    const script = EMBED_SCRIPT.match(/function campaignOnly\(value\) \{[\s\S]*?\n  \}/)?.[0];
    expect(script).toBeTruthy();
    const KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "ctwa_clid"];
    const scriptRule = vm.runInNewContext(`(${script!.replace("function campaignOnly", "function")})`, { KEYS }) as (v: string) => string;
    for (const raw of ["https://u:p@a.co/p?utm_source=a&x=1#h", "https://a@b@a.co/?fbclid=F", "https://a.co/p?next=https://u:p@b.co", "https://a.co/@x?utm_term=t"]) {
      expect(scriptRule(raw), raw).toBe(campaignOnlyUrl(raw));
    }
  });
});

describe("campaignOnlyUrl()", () => {
  it("keeps only utm_* and click ids, as written and in order, and drops the fragment", () => {
    expect(campaignOnlyUrl("https://a.co/p?a=1&utm_source=fb&b=2&gclid=G1#x")).toBe("https://a.co/p?utm_source=fb&gclid=G1");
    expect(campaignOnlyUrl("https://a.co/p?token=secret&email=a%40b.co")).toBe("https://a.co/p");
    expect(campaignOnlyUrl("https://a.co/p?")).toBe("https://a.co/p");
    expect(campaignOnlyUrl("https://a.co/p#utm_source=x")).toBe("https://a.co/p");
    expect(campaignOnlyUrl("https://a.co/p?utm_campaign=%D7%90+%D7%91&fbclid=F&ctwa_clid=C")).toBe(
      "https://a.co/p?utm_campaign=%D7%90+%D7%91&fbclid=F&ctwa_clid=C",
    );
    expect(campaignOnlyUrl("https://a.co/p?utm_source_x=1&Utm_source=2")).toBe("https://a.co/p");
    // user info in the authority goes; an @ in the path or the query stays
    expect(campaignOnlyUrl("https://user:pass@a.co/p?utm_source=x&t=1")).toBe("https://a.co/p?utm_source=x");
    expect(campaignOnlyUrl("https://a@b@a.co:8443/p")).toBe("https://a.co:8443/p");
    expect(campaignOnlyUrl("https://a.co/@x?utm_term=t")).toBe("https://a.co/@x?utm_term=t");
    expect(campaignOnlyUrl("https://a.co?next=https://u:p@b.co")).toBe("https://a.co");
  });
});

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { redactPublicPath, requestErrorLine } from "@/lib/request-error-log";

// FXC-13: the server log line of a captured error carries the code shown on the error screen, and nothing private.
describe("server log line of a request error", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJlLXZhbHVl";

  it("names the code (digest) the user sees, the route, the kind of request and the error", () => {
    const error = Object.assign(new Error("lead statuses query failed: timeout"), { digest: "2817364519" });
    expect(requestErrorLine(error, { path: "/o/abc/leads", method: "GET" }, { routePath: "/o/[orgId]/leads", routeType: "render", renderSource: "react-server-components" })).toBe(
      "[error] code=2817364519 route=/o/[orgId]/leads type=render/react-server-components GET /o/abc/leads Error: lead statuses query failed: timeout",
    );
  });

  it("drops the query string and redacts token-like text in the message", () => {
    const error = Object.assign(new SyntaxError(`Unexpected token 'e', "${jwt.slice(0, 10)}"... is not valid JSON`), { digest: "1" });
    const line = requestErrorLine(error, { path: `/o/abc/files/x?token=${jwt}&email=dana@example.com`, method: "POST" }, { routeType: "action" });
    expect(line).not.toContain(jwt.slice(0, 8));
    expect(line).not.toContain("dana@example.com");
    expect(line).toContain("POST /o/abc/files/x ");
    expect(line).toContain("route=? type=action");
  });

  it("copes with an error without a digest, and with a thrown non-error", () => {
    expect(requestErrorLine(new TypeError("boom"), { path: "/", method: "GET" }, {})).toBe("[error] code=none route=? type=? GET / TypeError: boom");
    expect(requestErrorLine("text", { path: "/x", method: "GET" }, {})).toBe("[error] code=none route=? type=? GET /x string");
  });

  it("hides the secret token of every public link's path, and keeps the rest of the path", () => {
    const t = "0123456789abcdef0123456789abcdef";
    const cases: [string, string][] = [
      [`/f/${t}`, "/f/[token]"],
      [`/f/${t}/qr`, "/f/[token]/qr"],
      [`/f/book/${t}`, "/f/book/[token]"],
      [`/f/book/manage/${t}`, "/f/book/manage/[token]"],
      [`/f/card/${t}`, "/f/card/[token]"],
      [`/f/quote/${t}`, "/f/quote/[token]"],
      [`/f/q/${t}`, "/f/q/[token]"],
      [`/api/forms/${t}`, "/api/forms/[token]"],
      [`/api/forms/booking/${t}`, "/api/forms/booking/[token]"],
      [`/api/forms/booking/manage/${t}`, "/api/forms/booking/manage/[token]"],
      [`/api/forms/card/${t}`, "/api/forms/card/[token]"],
      [`/api/forms/card/${t}/vcard`, "/api/forms/card/[token]/vcard"],
      // QUO-09: the decision route
      [`/api/forms/quote/${t}/decide`, "/api/forms/quote/[token]/decide"],
      // ORD-05: the customer's order page and its decision route
      [`/f/order/${t}`, "/f/order/[token]"],
      [`/api/forms/order/${t}/decide`, "/api/forms/order/[token]/decide"],
      [`/api/in/${t}`, "/api/in/[token]"],
      [`/api/calendar-feed/${t}.ics`, "/api/calendar-feed/[token]"],
      // SPD-07: the site widget's script, form page and form route
      [`/f/w/${t}.js`, "/f/w/[token]"],
      [`/f/widget/${t}`, "/f/widget/[token]"],
      [`/api/forms/widget/${t}`, "/api/forms/widget/[token]"],
      // QUO-06 / QUO-08: the customer's quote PDF and question routes
      [`/api/forms/quote/${t}/pdf`, "/api/forms/quote/[token]/pdf"],
      [`/api/forms/quote/${t}/question`, "/api/forms/quote/[token]/question"],
      // ORD-05: a future order PDF route sits under the same prefix
      [`/api/forms/order/${t}/pdf`, "/api/forms/order/[token]/pdf"],
      // BAL-04: the statement page and its PDF route
      [`/f/statement/${t}`, "/f/statement/[token]"],
      [`/api/forms/statement/${t}/pdf`, "/api/forms/statement/[token]/pdf"],
    ];
    for (const [path, shown] of cases) {
      expect(redactPublicPath(path), path).toBe(shown);
      const line = requestErrorLine(new Error("boom"), { path: `${path}?utm_source=qr`, method: "GET" }, {});
      expect(line, path).not.toContain(t);
      expect(line, path).toContain(`GET ${shown} `);
    }
  });

  it("leaves paths that carry no secret readable", () => {
    for (const path of [
      "/",
      "/app",
      "/o/abc/leads",
      "/o/abc/settings/qr-codes",
      "/f/embed.js",
      "/f/book",
      "/f/book/",
      "/f/card/",
      "/api/forms/booking/",
      "/api/forms/widget/",
      "/api/forms/statement/",
      "/f/w/",
      "/f/widget",
      "/api/push/dispatch",
      "/api/files/cleanup",
      "/login",
    ]) {
      expect(redactPublicPath(path), path).toBe(path);
    }
  });

  it("hides the token of every public route and page in the app's own tree (src/app/api/forms, src/app/f)", () => {
    const t = "Zq9_-0123456789abcdefABCDEF0123456789abcdefABCDEF0123456789abcde";
    const routes: string[] = [];
    const walk = (dir: string, url: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name), `${url}/${entry.name}`);
        else if (/^(route|page)\.tsx?$/.test(entry.name) && url.includes("[token]")) routes.push(url);
      }
    };
    const app = fileURLToPath(new URL("../../src/app", import.meta.url));
    walk(join(app, "api/forms"), "/api/forms");
    walk(join(app, "f"), "/f");
    expect(routes).toContain("/api/forms/statement/[token]/pdf");
    for (const route of routes) {
      const path = route.replace("[token]", t);
      expect(redactPublicPath(path), route).not.toContain(t);
      expect(requestErrorLine(new Error("boom"), { path, method: "GET" }, {}), route).not.toContain(t);
    }
  });
});

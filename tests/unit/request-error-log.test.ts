import { describe, expect, it } from "vitest";

import { requestErrorLine } from "@/lib/request-error-log";

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
});

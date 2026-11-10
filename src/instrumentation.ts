import type { Instrumentation } from "next";

import { logEvent } from "@/lib/log";
import { requestErrorFields } from "@/lib/request-error-log";

// FXC-13: every server error Next.js captures (pages, route handlers, Server Actions, the proxy) is written to the
// server log with the code the user sees on the error screen, so support can find it; since OPS-06 as one structured
// line (event `request.error`) with the request id. An external error monitor (OPS-05) can read the same line later;
// none is connected here.
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  logEvent("error", "request.error", requestErrorFields(error, request, context));
};

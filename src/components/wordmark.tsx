import { APP_NAME } from "@/lib/app";
import { cn } from "@/lib/cn";

/** Product mark + name. The name itself lives in lib/app.ts. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <span aria-hidden="true" className="grid size-7 place-items-center rounded-md bg-accent">
        <span className="block size-2.5 rounded-full border-2 border-white" />
      </span>
      <span dir="ltr">{APP_NAME}</span>
    </span>
  );
}

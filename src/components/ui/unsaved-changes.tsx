"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

import { LeaveDialog } from "@/components/ui/dialog";
import { formSnapshot, isDirty, linkLeavesPage } from "@/lib/form-dirty";

type Props = {
  // the form's action state (useActionState); an answer with ok: true makes the current values the saved ones
  state?: unknown;
};

// set while the user's "leave without saving" is carried out; shared by every guard on the page, so a
// second dirty form neither asks again nor lets the browser ask on the unload that follows
let leaving = false;
let leavingTimer: ReturnType<typeof setTimeout> | undefined;

function startLeaving() {
  leaving = true;
  clearTimeout(leavingTimer);
  // a page that stays on screen (a link to the same page with another ?query) is guarded again after this
  leavingTimer = setTimeout(() => {
    leaving = false;
  }, 1500);
}

function snapshotOf(form: HTMLFormElement): string {
  return formSnapshot(new FormData(form));
}

function savedOk(state: unknown): boolean {
  return typeof state === "object" && state !== null && (state as { ok?: unknown }).ok === true;
}

/**
 * REC-11: warns before leaving a form with unsaved changes. Put it anywhere inside
 * the <form>. It compares what the form would send with what it started with, so a
 * change that is undone again does not count. While dirty it asks before a link
 * leaves the page (our own window, not window.confirm), lets the browser ask on
 * close or reload, and marks the form `data-unsaved` so a Dialog holding it asks
 * before closing. A submit in flight never warns; a saved answer clears it.
 * Leaving goes by the link's address (router.push inside the app, a full load elsewhere), so a link
 * that vanished meanwhile (a closed menu) still works.
 * Known gaps: the browser's back button and code that calls router.push itself are not stopped
 * (Next 16 has no global navigation hook; onNavigate exists per <Link> only).
 */
export function FormGuard({ state }: Props) {
  const anchor = useRef<HTMLSpanElement>(null);
  const baseline = useRef<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const router = useRouter();
  const { pending } = useFormStatus();
  const guarded = dirty && !pending;

  const check = useCallback(() => {
    const form = anchor.current?.closest("form");
    if (!form) return;
    setDirty(isDirty(baseline.current, snapshotOf(form)));
  }, []);

  // the starting values, and every change after them
  useEffect(() => {
    const form = anchor.current?.closest("form");
    if (!form) return;
    baseline.current = snapshotOf(form);
    let frame = 0;
    // a frame later: React has applied the state the event caused (controlled fields, hidden inputs)
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(check);
    };
    form.addEventListener("input", schedule);
    form.addEventListener("change", schedule);
    form.addEventListener("reset", schedule);
    // fields that appear, disappear or change value without an event of their own
    const observer = new MutationObserver(schedule);
    observer.observe(form, { subtree: true, childList: true, attributes: true, attributeFilter: ["value", "checked", "selected"] });
    return () => {
      cancelAnimationFrame(frame);
      form.removeEventListener("input", schedule);
      form.removeEventListener("change", schedule);
      form.removeEventListener("reset", schedule);
      observer.disconnect();
    };
  }, [check]);

  // an answer from the server: saved means the values on screen are now the starting point
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const form = anchor.current?.closest("form");
      if (!form) return;
      if (savedOk(state)) baseline.current = snapshotOf(form);
      check();
    });
    return () => cancelAnimationFrame(frame);
  }, [state, check]);

  useEffect(() => {
    const form = anchor.current?.closest("form");
    if (!form) return;
    form.toggleAttribute("data-unsaved", guarded);
    return () => form.removeAttribute("data-unsaved");
  }, [guarded]);

  useEffect(() => {
    if (!guarded) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (leaving) return;
      // the browser shows its own question; the text cannot be changed
      event.preventDefault();
      event.returnValue = "";
    };
    const onClick = (event: MouseEvent) => {
      if (leaving || event.defaultPrevented) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement)) return;
      const leaves = linkLeavesPage(
        {
          href: link.href,
          target: link.target,
          download: link.hasAttribute("download"),
          button: event.button,
          modifier: event.metaKey || event.ctrlKey || event.shiftKey || event.altKey,
        },
        window.location.href,
      );
      if (!leaves) return;
      // capture phase on window: runs before next/link, which then never sees the click, and before
      // any other guard on the page, so one question is asked
      event.preventDefault();
      event.stopImmediatePropagation();
      setLeaveTo(link.href);
    };
    // back from the browser's page cache after leaving: guard again
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) leaving = false;
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("click", onClick, true);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("click", onClick, true);
    };
  }, [guarded]);

  return (
    <>
      <span ref={anchor} hidden />
      {leaveTo !== null ? (
        <LeaveDialog
          onStay={() => setLeaveTo(null)}
          onLeave={() => {
            const to = new URL(leaveTo, window.location.href);
            setLeaveTo(null);
            startLeaving();
            if (to.origin === window.location.origin) {
              router.push(to.pathname + to.search + to.hash);
            } else {
              window.location.assign(to.href);
            }
          }}
        />
      ) : null}
    </>
  );
}

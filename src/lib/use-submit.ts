"use client";

import { startTransition, type FormEvent } from "react";

/**
 * onSubmit handler for forms that have controlled fields.
 *
 * A form wired with `<form action={...}>` is reset by React when the action
 * finishes, which puts a controlled <select> back on its first option while the
 * component state still holds the user's choice. Submitting by hand skips that
 * reset. Forms without controlled fields should keep using `action`, which also
 * works before JavaScript loads.
 */
export function submitWith(dispatch: (formData: FormData) => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatch(formData));
  };
}

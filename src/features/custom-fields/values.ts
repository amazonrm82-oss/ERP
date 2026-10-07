import { formatDate, formatNumber } from "@/lib/format";

import { inputName, type CustomValues, type FieldDefinition } from "./types";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\+?[\d\s\-().*]{3,24}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The database checks the same (migration 0026): 2026-02-30 is not a date.
function isCalendarDate(text: string): boolean {
  if (!DATE_RE.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/**
 * Reads the custom fields of a form. Returns the values to store (only for the
 * given, active definitions; an empty field becomes null) and per-input errors.
 */
export function parseCustomFields(
  definitions: FieldDefinition[],
  formData: FormData,
): { values: CustomValues; errors: Record<string, string> } {
  const values: CustomValues = {};
  const errors: Record<string, string> = {};

  for (const field of definitions) {
    const name = inputName(field.key);
    const raw = formData.get(name);
    const text = typeof raw === "string" ? raw.trim() : "";

    if (field.type === "checkbox") {
      const checked = raw === "on" || raw === "true";
      if (field.isRequired && !checked) {
        errors[name] = "יש לסמן את השדה.";
      }
      values[field.key] = checked;
      continue;
    }
    if (text === "") {
      if (field.isRequired) {
        errors[name] = "יש למלא את השדה.";
      }
      values[field.key] = null;
      continue;
    }

    switch (field.type) {
      case "number": {
        const number = Number(text.replace(/,/g, ""));
        if (!Number.isFinite(number)) {
          errors[name] = "יש להזין מספר.";
        } else {
          values[field.key] = number;
        }
        break;
      }
      case "select":
        if (!field.options.includes(text)) {
          errors[name] = "יש לבחור ערך מהרשימה.";
        } else {
          values[field.key] = text;
        }
        break;
      case "date":
        if (!isCalendarDate(text)) {
          errors[name] = "התאריך אינו תקין.";
        } else {
          values[field.key] = text;
        }
        break;
      case "email":
        if (!EMAIL_RE.test(text) || text.length > 254) {
          errors[name] = "כתובת האימייל אינה תקינה.";
        } else {
          values[field.key] = text.toLowerCase();
        }
        break;
      case "phone":
        if (!PHONE_RE.test(text)) {
          errors[name] = "מספר הטלפון אינו תקין.";
        } else {
          values[field.key] = text;
        }
        break;
      case "url": {
        const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
        try {
          const url = new URL(withScheme);
          if (!url.hostname.includes(".")) throw new Error("no dot");
          values[field.key] = url.toString();
        } catch {
          errors[name] = "הקישור אינו תקין.";
        }
        break;
      }
      case "long_text":
        if (text.length > 5000) {
          errors[name] = "הטקסט ארוך מדי (עד 5,000 תווים).";
        } else {
          values[field.key] = text;
        }
        break;
      default:
        if (text.length > 500) {
          errors[name] = "הטקסט ארוך מדי (עד 500 תווים).";
        } else {
          values[field.key] = text;
        }
    }
  }
  return { values, errors };
}

/** The stored value as an input's default value. */
export function inputValue(field: FieldDefinition, values: CustomValues): string {
  const value = values[field.key];
  if (value === null || value === undefined) {
    return "";
  }
  if (field.type === "checkbox") {
    return value === true ? "on" : "";
  }
  return String(value);
}

export type CustomFieldDisplay = { key: string; label: string; text: string | null; ltr: boolean; href: string | null };

/** Active fields with their values, formatted for a details card. */
export function displayCustomFields(definitions: FieldDefinition[], values: CustomValues): CustomFieldDisplay[] {
  return definitions.map((field) => {
    const value = values[field.key];
    let text: string | null = null;
    if (value !== null && value !== undefined && value !== "") {
      if (field.type === "checkbox") text = value === true ? "כן" : "לא";
      else if (field.type === "number" && typeof value === "number") text = formatNumber(value);
      else if (field.type === "date" && typeof value === "string") text = formatDate(value);
      else text = String(value);
    } else if (field.type === "checkbox") {
      text = "לא";
    }
    return {
      key: field.key,
      label: field.label,
      text,
      ltr: ["phone", "email", "url", "number"].includes(field.type),
      href: field.type === "url" && typeof value === "string" ? value : null,
    };
  });
}

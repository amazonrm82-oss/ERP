import { formatDate, formatDateTime, formatMoney, formatNumber, parseMoneyToAgorot, zoneDate, zonedIso, zoneTime } from "@/lib/format";

import { inputName, type CustomValues, type FieldDefinition } from "./types";
import { isCalendarDate } from "@/lib/calendar-date";
import { israeliIdNumber } from "@/lib/israeli-id";

export { israeliIdNumber };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\+?[\d\s\-().*]{3,24}$/;
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;

/** Picked values of a multiple choice: several inputs, or one text with commas (imports). */
function multiValues(formData: FormData, name: string): string[] {
  const all = formData.getAll(name).filter((v): v is string => typeof v === "string");
  const parts = all.length === 1 ? all[0].split(/[,;\n]/) : all;
  return [...new Set(parts.map((v) => v.trim()).filter(Boolean))];
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

    if (field.type === "multi_select") {
      const picked = multiValues(formData, name);
      if (picked.some((v) => !field.options.includes(v))) {
        errors[name] = "יש לבחור ערכים מהרשימה.";
      } else if (picked.length === 0) {
        if (field.isRequired) errors[name] = "יש לבחור לפחות ערך אחד.";
        values[field.key] = null;
      } else {
        values[field.key] = field.options.filter((option) => picked.includes(option));
      }
      continue;
    }
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
      case "currency": {
        const agorot = parseMoneyToAgorot(text);
        if (agorot === null) errors[name] = "יש להזין סכום בשקלים.";
        else values[field.key] = agorot;
        break;
      }
      case "percent": {
        const percent = Number(text.replace(/[%\s]/g, ""));
        if (!Number.isFinite(percent) || Math.abs(percent) > 100000) errors[name] = "יש להזין אחוז.";
        else values[field.key] = percent;
        break;
      }
      case "rating": {
        const rating = Number(text);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) errors[name] = "יש לבחור דירוג בין 1 ל-5.";
        else values[field.key] = rating;
        break;
      }
      case "datetime": {
        const match = DATETIME_RE.exec(text);
        if (!match || !isCalendarDate(match[1]) || Number(match[2].slice(0, 2)) > 23 || Number(match[2].slice(3)) > 59) {
          errors[name] = "התאריך והשעה אינם תקינים.";
        } else {
          values[field.key] = zonedIso(match[1], `${match[2]}:00`);
        }
        break;
      }
      case "user":
        if (!(field.choices ?? []).some((choice) => choice.value === text)) errors[name] = "יש לבחור משתמש מהרשימה.";
        else values[field.key] = text;
        break;
      case "il_id":
      case "il_company_id": {
        const id = israeliIdNumber(text);
        if (!id) errors[name] = field.type === "il_id" ? "מספר תעודת הזהות אינו תקין." : "המספר אינו תקין.";
        else values[field.key] = id;
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
  if (field.type === "multi_select") {
    return Array.isArray(value) ? value.filter((v) => typeof v === "string").join("\n") : "";
  }
  if (field.type === "currency" && typeof value === "number") {
    return String(value / 100);
  }
  if (field.type === "datetime" && typeof value === "string") {
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? "" : `${zoneDate(at)}T${zoneTime(at)}`;
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
      else if (field.type === "currency" && typeof value === "number") text = formatMoney(value);
      else if (field.type === "percent" && typeof value === "number") text = `${formatNumber(value)}%`;
      else if (field.type === "rating" && typeof value === "number") text = `${value} מתוך 5`;
      else if (field.type === "multi_select") text = Array.isArray(value) ? value.join(", ") || null : String(value);
      else if (field.type === "date" && typeof value === "string") text = formatDate(value);
      else if (field.type === "datetime" && typeof value === "string") text = formatDateTime(value);
      else if (field.type === "user" && typeof value === "string") text = field.choices?.find((c) => c.value === value)?.label ?? "משתמש שאינו בעסק";
      else text = String(value);
    } else if (field.type === "checkbox") {
      text = "לא";
    }
    return {
      key: field.key,
      label: field.label,
      text,
      ltr: ["phone", "email", "url", "number", "percent", "il_id", "il_company_id"].includes(field.type),
      href: field.type === "url" && typeof value === "string" ? value : null,
    };
  });
}

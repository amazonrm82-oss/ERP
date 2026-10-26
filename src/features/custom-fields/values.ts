import { formatDate, formatDateTime, formatMoney, formatNumber, parseMoneyToAgorot, zoneDate, zonedIso, zoneTime } from "@/lib/format";

import { notePlainText, sanitizeNote } from "@/features/activities/markdown";

import { statusTone, type StatusColor } from "./status-colors";
import { inputName, type CustomValues, type FieldDefinition } from "./types";
import { isCalendarDate } from "@/lib/calendar-date";
import { israeliIdNumber } from "@/lib/israeli-id";
import { isUuid } from "@/lib/paths";

import { mapLinks, type MapLinks } from "./links";

export { israeliIdNumber };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\+?[\d\s\-().*]{3,24}$/;
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;

// FLD-06: a duration is whole minutes, from 0 to a year (app.custom_value_ok holds the same)
export const MAX_DURATION_MINUTES = 525_600;
export const MAX_RICH_TEXT_LENGTH = 5000;
// FLD-06 part B: an address is one line (app.custom_value_ok holds the same)
export const MAX_ADDRESS_LENGTH = 500;
// FLD-06 part B: how a record link or a file is shown when the page did not read it (or the viewer may not read it)
export const RECORD_LINK_FALLBACK = "רשומה";
export const FILE_FALLBACK = "קובץ";

/** "90" (minutes) or "1:30" (hours and minutes) -> minutes; null when it is neither, or past a year. */
export function parseDuration(text: string): number | null {
  const trimmed = text.trim();
  let minutes: number;
  if (/^\d{1,6}$/.test(trimmed)) {
    minutes = Number(trimmed);
  } else {
    const match = /^(\d{1,4}):([0-5]\d)$/.exec(trimmed);
    if (!match) return null;
    minutes = Number(match[1]) * 60 + Number(match[2]);
  }
  return minutes <= MAX_DURATION_MINUTES ? minutes : null;
}

/** Minutes as the duration input shows them: "1:30", or "45" under an hour. */
export function durationInput(minutes: number): string {
  if (minutes < 60) return String(minutes);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Minutes in words: "45 דקות", "שעה", "שעתיים ו-15 דקות". */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const minuteText = rest === 1 ? "דקה" : `${rest} דקות`;
  if (hours === 0) return minuteText;
  const hourText = hours === 1 ? "שעה" : hours === 2 ? "שעתיים" : `${hours} שעות`;
  return rest === 0 ? hourText : `${hourText} ו-${minuteText}`;
}

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
    // FLD-06 part B: a file is uploaded and set on its own (field-file actions), never through the record's form
    if (field.type === "file") continue;
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
        // the database checks the same (app.custom_value_ok, RVW-14)
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
        // any membership of the business, a suspended one included; the database checks the same (app.check_custom_fields, RVW-14)
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
      case "duration": {
        const minutes = parseDuration(text);
        if (minutes === null) errors[name] = "יש להזין משך בדקות (90) או בשעות ודקות (1:30), עד שנה.";
        else values[field.key] = minutes;
        break;
      }
      case "address":
        // one line; the database checks the same (app.custom_value_ok)
        if (/[\r\n]/.test(text)) errors[name] = "הכתובת צריכה להיות בשורה אחת.";
        else if (text.length > MAX_ADDRESS_LENGTH) errors[name] = "הכתובת ארוכה מדי (עד 500 תווים).";
        else values[field.key] = text;
        break;
      case "record_link":
        // the picker's id; the database checks that it names a live record of the business that the writer reads
        if (!isUuid(text)) errors[name] = "יש לבחור רשומה מהחיפוש.";
        else values[field.key] = text.toLowerCase();
        break;
      case "rich_text": {
        // REC-04: stored as cleaned Markdown, never HTML
        const clean = sanitizeNote(text);
        if (clean.length > MAX_RICH_TEXT_LENGTH) errors[name] = "הטקסט ארוך מדי (עד 5,000 תווים).";
        else values[field.key] = clean;
        break;
      }
      case "status":
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
        // length first (as app.custom_value_ok() does): the regex is slow on very long text
        if (text.length > 254 || !EMAIL_RE.test(text)) {
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
  if (field.type === "duration" && typeof value === "number") {
    return durationInput(value);
  }
  if (field.type === "datetime" && typeof value === "string") {
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? "" : `${zoneDate(at)}T${zoneTime(at)}`;
  }
  return String(value);
}

export type CustomFieldDisplay = {
  key: string;
  label: string;
  // plain text (lists, exports, the board); a rich text field's words without its marks
  text: string | null;
  ltr: boolean;
  href: string | null;
  // FLD-06: a rich text field's cleaned Markdown, for the details card (rendered by NoteText, never as HTML)
  markdown?: string | null;
  // FLD-06: a status value's palette key
  tone?: StatusColor | null;
  // FLD-06 part B: a page inside the app (a linked record, a field's file), opened in the same tab
  internalHref?: string | null;
  // FLD-06 part B: an address's Waze and Google Maps links
  maps?: MapLinks | null;
};

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
      else if (field.type === "duration" && typeof value === "number") text = formatDuration(value);
      else if (field.type === "rich_text" && typeof value === "string") text = notePlainText(value) || null;
      else if (field.type === "record_link" && typeof value === "string") text = field.refs?.[value]?.label ?? RECORD_LINK_FALLBACK;
      else if (field.type === "file" && typeof value === "string") text = field.refs?.[value]?.label ?? FILE_FALLBACK;
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
      markdown: field.type === "rich_text" && typeof value === "string" && value.trim() !== "" ? value : null,
      tone: field.type === "status" && typeof value === "string" && value !== "" ? statusTone(field, value) : null,
      internalHref:
        (field.type === "record_link" || field.type === "file") && typeof value === "string" ? (field.refs?.[value]?.href ?? null) : null,
      maps: field.type === "address" && typeof value === "string" ? mapLinks(value) : null,
    };
  });
}

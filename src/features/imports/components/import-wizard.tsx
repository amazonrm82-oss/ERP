"use client";

import Link from "next/link";
import { useId, useRef, useState } from "react";

import { byGender, DEFAULT_TERMS, type OrgTerms } from "@/features/terminology/terms";
import { Button, buttonClasses } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { Select, SelectField, TextareaField } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { defuseFormula } from "@/lib/csv";
import { formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";
import { RECORD_TYPES } from "@/lib/record-types";

import { productsPath } from "@/features/products/paths";

import { finishImportAction, importChunkAction, previewImportAction, startImportAction } from "../actions";
import {
  CHUNK_SIZE,
  CUSTOM_PREFIX,
  DEAL_DUPLICATE_HINT,
  DUPLICATE_MODES,
  duplicateModesFor,
  IMPORT_ENTITIES,
  importEntityLabel,
  IMPORT_TARGETS,
  MAX_IMPORT_ROWS,
  PRODUCT_DUPLICATE_HINT,
  suggestMapping,
  TASK_DUPLICATE_HINT,
  type DuplicateModeKey,
  type ImportEntityKey,
} from "../fields";
import type { RowOutcome } from "../server";
import { cellText } from "../cell-text";
import {
  CONSENT_GRANTED_VALUES,
  CONSENT_DENIED_VALUES,
  consentDeclarationSchema,
  consentsLockedText,
  IMPORT_CONSENT_METHOD_LABELS,
  IMPORT_CONSENT_METHODS,
  IMPORT_CONSENT_NOTE_MAX,
  mapsConsent,
} from "../consent";
import { columnValues } from "../new-field";
import { moreRowsText, warnedRowsTitle } from "../wording";
import { NewFieldForm } from "./new-field-form";

type CustomField = { key: string; label: string };
// canCreateFields: owners and admins may add a custom field while mapping (IMP-01)
// canImportProducts: owners and admins write the product catalog (PRD-05)
// FLD-10: terms = the business's words for leads, contacts and deals
type Props = {
  orgId: string;
  customFields: Record<ImportEntityKey, CustomField[]>;
  canCreateFields: boolean;
  canImportProducts: boolean;
  initialEntity?: ImportEntityKey;
  terms?: OrgTerms;
};

type Sheet = { fileName: string; headers: string[]; rows: string[][] };
type Step = "file" | "map" | "preview" | "running" | "done";
type Totals = { created: number; updated: number; skipped: number; failed: number };
// CNS-05: consents written to the register, and those an opt-out kept out
type ConsentTotals = { written: number; locked: number };

const PREVIEW_ROWS = 20;
const WARNINGS_SHOWN = 10;

/** UTF-8 first; a file Excel saved as "CSV" in Hebrew Windows is Windows-1255. */
function decode(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1255").decode(buffer);
  }
}

async function readFile(file: File): Promise<Sheet> {
  const name = file.name.toLowerCase();
  let table: string[][];
  if (name.endsWith(".xlsx")) {
    const { readSheet } = await import("read-excel-file/browser");
    const data = (await readSheet(file)) as unknown[][];
    table = data.map((row) => row.map(cellText));
  } else if (name.endsWith(".csv") || name.endsWith(".txt")) {
    const Papa = (await import("papaparse")).default;
    const parsed = Papa.parse<string[]>(decode(await file.arrayBuffer()), { skipEmptyLines: "greedy" });
    table = parsed.data.map((row) => row.map(cellText));
  } else if (name.endsWith(".xls")) {
    throw new Error("קובץ Excel ישן (xls.) לא נתמך. שמרו אותו ב-Excel בתור xlsx או CSV ונסו שוב.");
  } else {
    throw new Error("אפשר לייבא קובץ Excel (xlsx.) או CSV.");
  }
  table = table.filter((row) => row.some((cell) => cell !== ""));
  if (table.length < 2) throw new Error("בקובץ אין שורות לייבוא. השורה הראשונה צריכה להיות כותרות, ומתחתיה הנתונים.");
  if (table.length - 1 > MAX_IMPORT_ROWS) throw new Error(`בקובץ יש ${formatNumber(table.length - 1)} שורות. אפשר לייבא עד ${formatNumber(MAX_IMPORT_ROWS)} שורות בכל פעם.`);
  const width = Math.max(...table.map((row) => row.length));
  if (width > 200) throw new Error("בקובץ יותר מ-200 עמודות.");
  const headers = Array.from({ length: width }, (_, i) => table[0][i] || `עמודה ${i + 1}`);
  return { fileName: file.name, headers, rows: table.slice(1).map((row) => Array.from({ length: width }, (_, i) => (row[i] ?? "").slice(0, 10_000))) };
}

function csvLine(cells: string[]): string {
  return cells.map((c) => `"${defuseFormula(c).replace(/"/g, '""')}"`).join(",");
}

// PRD-05, IMP-03: a products, deals or tasks file needs this column mapped
const REQUIRED_COLUMN: Record<ImportEntityKey, { key: string; hint: string } | null> = {
  lead: null,
  contact: null,
  company: null,
  product: { key: "name", hint: "בחרו את העמודה של שם המוצר." },
  deal: { key: "name", hint: "בחרו את העמודה של שם העסקה." },
  task: { key: "title", hint: "בחרו את העמודה של כותרת המשימה." },
};

const OUTCOME_LABEL: Record<RowOutcome["status"], string> = {
  ok: "ייווצר",
  created: "נוצר",
  updated: "יעודכן",
  skipped: "ידולג (כבר קיים)",
  failed: "שגיאה",
};

export function ImportWizard({ orgId, customFields: initialFields, canCreateFields, canImportProducts, initialEntity = "lead", terms = DEFAULT_TERMS }: Props) {
  const [customFields, setCustomFields] = useState(initialFields);
  // the column whose "new field" form is open
  const [newFieldFor, setNewFieldFor] = useState<number | null>(null);
  const [step, setStep] = useState<Step>("file");
  const [entity, setEntity] = useState<ImportEntityKey>(initialEntity);
  const [mode, setMode] = useState<DuplicateModeKey>("skip");
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [mapping, setMapping] = useState<string[]>([]);
  const [preview, setPreview] = useState<RowOutcome[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [totals, setTotals] = useState<Totals>({ created: 0, updated: 0, skipped: 0, failed: 0 });
  const [failures, setFailures] = useState<RowOutcome[]>([]);
  const [warnings, setWarnings] = useState<RowOutcome[]>([]);
  const [stopped, setStopped] = useState<string | null>(null);
  // CNS-05: the importer's declaration of where the file's consents came from
  const [consentMethod, setConsentMethod] = useState("");
  const [consentNote, setConsentNote] = useState("");
  const [consentTotals, setConsentTotals] = useState<ConsentTotals>({ written: 0, locked: 0 });
  const fileRef = useRef<HTMLInputElement>(null);
  const fileId = useId();

  const targets = [
    ...IMPORT_TARGETS[entity],
    ...customFields[entity].map((f) => ({ key: `${CUSTOM_PREFIX}${f.key}`, label: `${f.label} (שדה מותאם)`, synonyms: [f.label] })),
  ];

  async function onFile(file: File | undefined) {
    setError(null);
    if (!file) return;
    setBusy(true);
    try {
      const read = await readFile(file);
      setSheet(read);
      setMapping(suggestMapping(read.headers, targets));
      setStep("map");
    } catch (e) {
      setError(e instanceof Error ? e.message : "לא הצלחנו לקרוא את הקובץ.");
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    if (!sheet) return;
    setError(null);
    setBusy(true);
    const result = await previewImportAction(orgId, { entity, mode, mapping, rows: sheet.rows.slice(0, PREVIEW_ROWS) });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPreview(result.data ?? []);
    setStep("preview");
  }

  async function run() {
    if (!sheet) return;
    setError(null);
    const start = await startImportAction(orgId, {
      entity,
      mode,
      fileName: sheet.fileName,
      totalRows: sheet.rows.length,
      // CON-09: a mapped company column decides the company; otherwise the database links new contacts by email domain
      mapsCompany: entity === "contact" && mapping.includes("company"),
      consent: withConsent ? { method: consentMethod, note: consentNote } : null,
    });
    if (!start.ok || !start.data) {
      setError(start.ok ? "לא הצלחנו להתחיל את הייבוא." : start.message);
      return;
    }
    const jobId = start.data.jobId;
    setStep("running");
    const sum: Totals = { created: 0, updated: 0, skipped: 0, failed: 0 };
    const failed: RowOutcome[] = [];
    const warned: RowOutcome[] = [];
    const consentSum: ConsentTotals = { written: 0, locked: 0 };
    let stop: string | null = null;
    for (let offset = 0; offset < sheet.rows.length && !stop; offset += CHUNK_SIZE) {
      const result = await importChunkAction(orgId, jobId, { mapping, rows: sheet.rows.slice(offset, offset + CHUNK_SIZE), firstRow: offset + 1 }).catch(() => null);
      if (!result || !result.ok || !result.data) {
        stop = result && !result.ok ? result.message : "החיבור נקטע באמצע הייבוא.";
        break;
      }
      stop = result.data.stopped;
      for (const outcome of result.data.outcomes) {
        consentSum.written += outcome.consents ?? 0;
        consentSum.locked += outcome.consentsLocked ?? 0;
        if (outcome.warning && outcome.status !== "failed") warned.push(outcome);
        if (outcome.status === "created") sum.created += 1;
        else if (outcome.status === "updated") sum.updated += 1;
        else if (outcome.status === "skipped") sum.skipped += 1;
        else if (outcome.status === "failed") {
          sum.failed += 1;
          failed.push(outcome);
        }
      }
      setTotals({ ...sum });
      setConsentTotals({ ...consentSum });
      setProgress(Math.min(sheet.rows.length, offset + CHUNK_SIZE));
    }
    await finishImportAction(orgId, jobId, { updated: sum.updated, skipped: sum.skipped, failed: sum.failed, stopped: Boolean(stop) });
    setFailures(failed);
    setWarnings(warned);
    setStopped(stop);
    setStep("done");
  }

  function downloadFailures() {
    if (!sheet) return;
    const lines = [csvLine([...sheet.headers, "שגיאה"]), ...failures.map((f) => csvLine([...(sheet.rows[f.row - 1] ?? []), f.message ?? ""]))];
    const blob = new Blob([`﻿${lines.join("\r\n")}\r\n`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `שורות-שנכשלו-${sheet.fileName.replace(/\.[^.]+$/, "")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function reset() {
    setStep("file");
    setNewFieldFor(null);
    setSheet(null);
    setMapping([]);
    setPreview([]);
    setError(null);
    setProgress(0);
    setTotals({ created: 0, updated: 0, skipped: 0, failed: 0 });
    setFailures([]);
    setWarnings([]);
    setStopped(null);
    setConsentMethod("");
    setConsentNote("");
    setConsentTotals({ written: 0, locked: 0 });
    if (fileRef.current) fileRef.current.value = "";
  }

  const mappedCount = mapping.filter(Boolean).length;
  const entityLabel = importEntityLabel(entity, terms);
  const entities = IMPORT_ENTITIES.filter((e) => e.value !== "product" || canImportProducts);
  const isProduct = entity === "product";
  // products and tasks: no custom fields (PRD-05, IMP-03)
  const canAddField = canCreateFields && !isProduct && entity !== "task";
  // the column a row cannot do without, and what to say until it is mapped
  const required = REQUIRED_COLUMN[entity];
  const missingRequired = required !== null && !mapping.includes(required.key);
  const ownHint = entity === "product" ? PRODUCT_DUPLICATE_HINT : entity === "deal" ? DEAL_DUPLICATE_HINT : entity === "task" ? TASK_DUPLICATE_HINT : null;
  const modes = DUPLICATE_MODES.filter((m) => duplicateModesFor(entity).includes(m.value));
  // CNS-05: a mapped consent column needs the declaration before the check and the import
  const withConsent = (entity === "lead" || entity === "contact") && mapsConsent(mapping);
  const declaration = consentDeclarationSchema.safeParse({ method: consentMethod, note: consentNote });
  const missingDeclaration = withConsent && !declaration.success;
  const listHref = isProduct ? productsPath(orgId) : RECORD_TYPES[entity].list(orgId);

  function chooseEntity(next: ImportEntityKey) {
    setEntity(next);
    if (!duplicateModesFor(next).includes(mode)) setMode(duplicateModesFor(next)[0]);
  }

  return (
    <div className="space-y-5">
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-soft" aria-label="שלבי הייבוא">
        {(["file", "map", "preview", "running"] as const).map((s, i) => (
          <li key={s} aria-current={step === s || (s === "running" && step === "done") ? "step" : undefined} className={cn((step === s || (s === "running" && step === "done")) && "font-semibold text-ink")}>
            {i + 1}. {["קובץ", "מיפוי עמודות", "בדיקה", "ייבוא"][i]}
          </li>
        ))}
      </ol>

      <FormError message={error} />

      {step === "file" ? (
        <div className="space-y-5 rounded-lg border border-line bg-surface p-4 sm:p-5">
          <fieldset>
            <legend className="mb-2 text-sm font-medium">מה מייבאים?</legend>
            <div className="flex flex-wrap gap-4">
              {entities.map((option) => (
                <label key={option.value} className="flex min-h-11 cursor-pointer items-center gap-2">
                  <input type="radio" name="entity" value={option.value} checked={entity === option.value} onChange={() => chooseEntity(option.value)} className="size-4 accent-accent" />
                  {importEntityLabel(option.value, terms)}
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <p className="mb-1.5 text-sm font-medium" id={`${fileId}-label`}>
              קובץ Excel או CSV
            </p>
            {/* the native control is visually hidden: its button text follows the browser's language, not the page's */}
            <input
              ref={fileRef}
              id={fileId}
              type="file"
              aria-labelledby={`${fileId}-label`}
              accept=".xlsx,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              disabled={busy}
              onChange={(e) => onFile(e.target.files?.[0])}
              className="peer sr-only"
            />
            <label htmlFor={fileId} className={cn(buttonClasses("secondary", "md"), "cursor-pointer peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent")}>
              בחירת קובץ
            </label>
            <p className="mt-1.5 text-sm text-ink-soft">
              השורה הראשונה בקובץ היא כותרות העמודות. עד {formatNumber(MAX_IMPORT_ROWS)} שורות. עברית נקראת גם מקובץ CSV ששמרתם ב-Excel.
            </p>
            {busy ? <p role="status" className="mt-2 text-sm">קורא את הקובץ…</p> : null}
          </div>
        </div>
      ) : null}

      {step === "map" && sheet ? (
        <div className="space-y-5">
          <div className="rounded-lg border border-line bg-surface">
            <p className="border-b border-line px-4 py-3 text-md sm:px-5">
              <span className="font-semibold">{sheet.fileName}</span>: {formatNumber(sheet.rows.length)} שורות, ייבוא ל{entityLabel}. לכל עמודה בחרו לאיזה שדה היא נכנסת.
            </p>
            <ul className="divide-y divide-line">
              {sheet.headers.map((header, index) => (
                <li key={index} className="grid gap-2 px-4 py-3 sm:grid-cols-[1fr_1fr_16rem] sm:items-center sm:px-5">
                  <span className="font-medium break-words">{header}</span>
                  <span className="truncate text-sm text-ink-soft" dir="auto">
                    {sheet.rows.find((r) => r[index])?.[index] ?? ""}
                  </span>
                  <div className="space-y-1">
                    <Select
                      aria-label={`שדה לעמודה ${header}`}
                      value={mapping[index] ?? ""}
                      onChange={(e) => setMapping((m) => m.map((v, i) => (i === index ? e.target.value : v)))}
                    >
                      <option value="">לא לייבא</option>
                      {targets.map((t) => (
                        <option key={t.key} value={t.key} disabled={mapping.includes(t.key) && mapping[index] !== t.key}>
                          {t.label}
                        </option>
                      ))}
                    </Select>
                    {canAddField && !mapping[index] && newFieldFor !== index ? (
                      <Button variant="ghost" size="sm" onClick={() => setNewFieldFor(index)} aria-label={`שדה חדש לעמודה ${header}`}>
                        + שדה חדש
                      </Button>
                    ) : null}
                  </div>
                  {newFieldFor === index ? (
                    <NewFieldForm
                      orgId={orgId}
                      entity={entity}
                      entityLabel={entityLabel}
                      header={header}
                      values={columnValues(sheet.rows, index)}
                      onCancel={() => setNewFieldFor(null)}
                      onCreated={(field) => {
                        setCustomFields((all) => ({ ...all, [entity]: [...all[entity], field] }));
                        setMapping((m) => m.map((v, i) => (i === index ? `${CUSTOM_PREFIX}${field.key}` : v)));
                        setNewFieldFor(null);
                      }}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
          {ownHint ? (
            <div className="rounded-lg border border-line bg-surface p-4 text-sm sm:p-5">
              <p className="font-medium">{isProduct ? "מוצר שכבר קיים" : "כפילויות"}</p>
              <p className="mt-1 text-ink-soft">{ownHint}</p>
              {isProduct ? (
                <p className="mt-1 text-ink-soft">כל מוצר שנוצר נספר במכסת המוצרים של החבילה. כשמגיעים למכסה הייבוא נעצר, והשורות שלא נכנסו מופיעות ברשימת השורות שנכשלו.</p>
              ) : null}
              {entity === "deal" ? (
                <>
                  <p className="mt-1 text-ink-soft">
                    תהליך המכירה והשלב נמצאים לפי השם. שם שלא קיים הוא שגיאה בשורה, ושלב חדש לא נוצר. בלי עמודת שלב {terms.deal.theSingular}{" "}
                    {byGender(terms.deal, "נכנס", "נכנסת")} לשלב הפתוח הראשון.
                  </p>
                  <p className="mt-1 text-ink-soft">
                    {terms.deal.singular} בשלב זכייה או הפסד {byGender(terms.deal, "נסגר", "נסגרת")} בתאריך הסגירה בפועל. בלעדיו, בתאריך הסגירה הצפוי אם כבר עבר, ואם אין, בתאריך הייבוא.
                  </p>
                  <p className="mt-1 text-ink-soft">
                    {terms.contact.singular} {byGender(terms.contact, "נמצא", "נמצאת")} לפי אימייל או טלפון, וחברה לפי שם או דומיין. כשלא נמצאה רשומה אחת בדיוק, השורה לא מיובאת.
                  </p>
                </>
              ) : null}
              {entity === "task" ? (
                <p className="mt-1 text-ink-soft">
                  {terms.lead.singular} ו{terms.contact.singular} נמצאים לפי טלפון או אימייל, חברה לפי שם או דומיין, ו{terms.deal.singular} לפי השם המדויק. כשלא נמצאה
                  רשומה אחת בדיוק, השורה לא מיובאת. שעות היעד הן לפי שעון העסק.
                </p>
              ) : null}
            </div>
          ) : (
            <fieldset className="rounded-lg border border-line bg-surface p-4 sm:p-5">
              <legend className="px-1 text-sm font-medium">שורה שכבר קיימת במערכת</legend>
              <div className="space-y-2">
                {modes.map((option) => (
                  <label key={option.value} className="flex cursor-pointer items-start gap-2">
                    <input type="radio" name="mode" value={option.value} checked={mode === option.value} onChange={() => setMode(option.value)} className="mt-1 size-4 accent-accent" />
                    <span>
                      <span className="block">{option.label}</span>
                      <span className="block text-sm text-ink-soft">{option.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {withConsent ? (
            <fieldset className="space-y-4 rounded-lg border border-line bg-surface p-4 sm:p-5">
              <legend className="px-1 text-sm font-medium">מקור ההסכמות לדיוור</legend>
              <div className="space-y-1 text-sm text-ink-soft">
                <p>
                  בעמודות ההסכמה נקראים רק הערכים: {CONSENT_GRANTED_VALUES.slice(0, 4).join(", ")} (הסכים), או {CONSENT_DENIED_VALUES.slice(0, 4).join(", ")} (לא הסכים). תא ריק
                  לא משנה כלום. ערך אחר לא נרשם, והשורה תציין את זה.
                </p>
                <p>
                  כתובת שחסומה לדיוור בעסק לא תסומן כמסכימה בגלל הקובץ. &quot;לא הסכים&quot; נרשם תמיד, גם בשורה שדולגה כי הרשומה כבר קיימת.
                </p>
              </div>
              <SelectField label="איך התקבלו ההסכמות?" required value={consentMethod} onChange={(e) => setConsentMethod(e.target.value)}>
                <option value="">בחרו</option>
                {IMPORT_CONSENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {IMPORT_CONSENT_METHOD_LABELS[m]}
                  </option>
                ))}
              </SelectField>
              <TextareaField
                label="פרטים על מקור ההסכמות"
                required
                hint="למשל: מאיזה טופס או אירוע, ובאילו תאריכים נאספו. הפרטים נשמרים עם כל הסכמה וביומן הפעולות."
                maxLength={IMPORT_CONSENT_NOTE_MAX}
                value={consentNote}
                onChange={(e) => setConsentNote(e.target.value)}
              />
            </fieldset>
          ) : null}
          {required && missingRequired ? <p className="text-sm text-ink-soft">{required.hint}</p> : null}
          {missingDeclaration ? <p className="text-sm text-ink-soft">כדי לייבא הסכמות, בחרו איך התקבלו וכתבו פרטים.</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button onClick={check} disabled={busy || mappedCount === 0 || missingRequired || missingDeclaration} aria-busy={busy || undefined}>
              {busy ? "בודקים…" : "בדיקת 20 השורות הראשונות"}
            </Button>
            <Button variant="ghost" onClick={reset}>
              קובץ אחר
            </Button>
          </div>
        </div>
      ) : null}

      {step === "preview" && sheet ? (
        <div className="space-y-5">
          <div role="region" aria-label="בדיקה של השורות הראשונות" tabIndex={0} className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full min-w-[36rem] text-md">
              <caption className="border-b border-line px-4 py-3 text-start font-semibold sm:px-5">בדיקה של {formatNumber(Math.min(PREVIEW_ROWS, sheet.rows.length))} השורות הראשונות</caption>
              <thead>
                <tr className="border-b border-line text-sm text-ink-soft">
                  <th scope="col" className="px-4 py-2 text-start font-medium sm:px-5">שורה</th>
                  {sheet.headers.map((h, i) => (mapping[i] ? <th key={i} scope="col" className="px-3 py-2 text-start font-medium">{targets.find((t) => t.key === mapping[i])?.label}</th> : null))}
                  <th scope="col" className="px-3 py-2 text-start font-medium">תוצאה</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {preview.map((outcome) => (
                  <tr key={outcome.row}>
                    <th scope="row" className="px-4 py-2 text-start font-normal sm:px-5">{outcome.row + 1}</th>
                    {sheet.headers.map((_, i) => (mapping[i] ? <td key={i} className="max-w-48 truncate px-3 py-2" dir="auto">{sheet.rows[outcome.row - 1]?.[i]}</td> : null))}
                    <td className={cn("px-3 py-2", outcome.status === "failed" ? "text-danger" : "text-ink-soft")}>
                      {OUTCOME_LABEL[outcome.status]}
                      {outcome.status === "failed" && outcome.message ? `: ${outcome.message}` : ""}
                      {outcome.status === "skipped" && isProduct && outcome.message ? `: ${outcome.message}` : ""}
                      {outcome.status !== "failed" && outcome.warning ? `. ${outcome.warning}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm text-ink-soft">מספרי השורות הם כמו בקובץ (שורה 1 היא הכותרות). שורות עם שגיאה לא ייובאו, ובסוף אפשר להוריד אותן לתיקון.</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={run} disabled={missingDeclaration}>ייבוא {formatNumber(sheet.rows.length)} שורות</Button>
            <Button variant="ghost" onClick={() => setStep("map")}>
              חזרה למיפוי
            </Button>
          </div>
        </div>
      ) : null}

      {(step === "running" || step === "done") && sheet ? (
        <div className="space-y-4 rounded-lg border border-line bg-surface p-4 sm:p-5">
          <div>
            <p className="mb-1.5 text-md">
              {step === "running" ? "מייבאים… אל תסגרו את הדף עד הסוף." : stopped ? "הייבוא נעצר." : "הייבוא הסתיים."} {formatNumber(progress)} מתוך {formatNumber(sheet.rows.length)} שורות.
            </p>
            <div role="progressbar" aria-label="התקדמות הייבוא" aria-valuemin={0} aria-valuemax={sheet.rows.length} aria-valuenow={progress} className="h-2.5 rounded-full bg-canvas">
              <div className="h-2.5 rounded-full bg-accent transition-[width]" style={{ width: `${(progress / sheet.rows.length) * 100}%` }} />
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-live="polite">
            {[
              ["נוצרו", totals.created],
              ["עודכנו", totals.updated],
              ["דולגו (כבר קיימים)", totals.skipped],
              ["נכשלו", totals.failed],
            ].map(([label, value]) => (
              <div key={label as string} className="rounded-md bg-canvas p-3">
                <dt className="text-sm text-ink-soft">{label}</dt>
                <dd className="text-xl font-semibold tabular-nums">{formatNumber(value as number)}</dd>
              </div>
            ))}
          </dl>
          {withConsent ? (
            <div className="space-y-1 text-md">
              <p>הסכמות שנרשמו: {formatNumber(consentTotals.written)}.</p>
              {/* CNS-06 answer 3: the addresses whose "מאשר" the register kept out */}
              {consentTotals.locked > 0 ? <p>{consentsLockedText(consentTotals.locked)}</p> : null}
            </div>
          ) : null}
          {stopped ? <p role="alert" className="text-danger">{stopped}</p> : null}
          {warnings.length > 0 ? (
            <div className="text-md">
              <p className="font-medium">{warnedRowsTitle(warnings.length)}</p>
              <ul className="mt-1 list-disc space-y-0.5 ps-5 text-ink-soft">
                {warnings.slice(0, WARNINGS_SHOWN).map((w) => (
                  <li key={w.row}>
                    שורה {formatNumber(w.row + 1)}: {w.warning}
                  </li>
                ))}
              </ul>
              {warnings.length > WARNINGS_SHOWN ? <p className="mt-1 text-sm text-ink-soft">{moreRowsText(warnings.length - WARNINGS_SHOWN)}</p> : null}
            </div>
          ) : null}
          {step === "done" ? (
            <div className="flex flex-wrap gap-2">
              <Link href={listHref} className={buttonClasses("primary", "md")}>
                ל{entityLabel}
              </Link>
              {failures.length > 0 ? (
                <Button variant="secondary" onClick={downloadFailures}>
                  הורדת {formatNumber(failures.length)} השורות שנכשלו
                </Button>
              ) : null}
              <Link href={paths.imports(orgId)} className={buttonClasses("ghost", "md")}>
                היסטוריית ייבוא וביטול
              </Link>
              <Button variant="ghost" onClick={reset}>
                ייבוא נוסף
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

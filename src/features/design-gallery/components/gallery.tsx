"use client";

import { useState, type ReactNode } from "react";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { Button, IconButton } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Calendar, DateField } from "@/components/ui/date-picker";
import { Dialog, LeaveDialog } from "@/components/ui/dialog";
import { EmptyState, FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox, SelectField, Switch, TextareaField, TextField } from "@/components/ui/field";
import * as Icons from "@/components/ui/icons";
import { BellIcon, PencilIcon, PlusIcon, TrashIcon } from "@/components/ui/icons";
import { Popover } from "@/components/ui/popover";
import { ReorderButtons } from "@/components/ui/reorder-buttons";
import { ListSkeleton, Skeleton } from "@/components/ui/skeleton";
import { ListCard, ListCards, Table, Td, Th, Tr } from "@/components/ui/table";
import { TextLink } from "@/components/ui/text-link";
import { ToastProvider, ToastView, useToast } from "@/components/ui/toast";
import { FormGuard } from "@/components/ui/unsaved-changes";
import { buttonClasses, iconButtonClasses } from "@/components/ui/button";
import { BrandScope } from "@/features/branding/components/brand-scope";
import { OrgLogo } from "@/features/branding/components/org-logo";
import { brandPalette } from "@/features/branding/color";
import sampleLogo from "@/assets/mexuz-logo.png";
import { HolidayLegend, HolidayMarks } from "@/features/calendar-days/components/holiday-marks";
import { holidaysOn } from "@/features/calendar-days/holidays";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-lead font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

// a colour that passes, one too light for white text, one too dark for the dark theme
const BRAND_SAMPLES = ["#0f7b6c", "#ffd400", "#5b2a86"];

const ok = async () => ({ ok: true as const });
const failing = async () => ({ ok: false as const, message: "לא הצלחנו להעביר לסל. נסו שוב." });

/** Every shared component in every state (DSN-08). Rendered once per theme by the page. */
export function DesignGallery({ theme }: { theme: "light" | "dark" }) {
  return (
    <ToastProvider>
      <GalleryBody theme={theme} />
    </ToastProvider>
  );
}

function GalleryBody({ theme }: { theme: "light" | "dark" }) {
  const toast = useToast();
  const [on, setOn] = useState(true);
  const [dialog, setDialog] = useState<"dialog" | "sheet" | null>(null);
  const [items, setItems] = useState(["חדש", "בטיפול", "נסגר"]);
  const [day, setDay] = useState("2026-10-09");
  const p = (name: string) => `${theme}-${name}`;

  function move(index: number, direction: -1 | 1) {
    setItems((list) => {
      const next = [...list];
      [next[index], next[index + direction]] = [next[index + direction], next[index]];
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-8">
      <Section title="אייקונים">
        <p className="text-sm text-ink-soft">קו אחד בעובי 1.75. &quot;חזרה&quot; ו&quot;קדימה&quot; מתהפכים לבד לפי כיוון הקריאה.</p>
        <ul className="grid grid-cols-4 gap-2 sm:grid-cols-8">
          {Object.entries(Icons).map(([name, Icon]) => (
            <li key={name} className="flex flex-col items-center gap-1 rounded-md border border-line bg-surface p-2 text-center">
              <Icon className="size-6" />
              <span dir="ltr" className="text-2xs text-ink-soft break-all">
                {name.replace(/Icon$/, "")}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="כפתורים">
        <Row>
          <Button>ראשי</Button>
          <Button variant="secondary">משני</Button>
          <Button variant="ghost">שקוף</Button>
          <Button variant="danger">מחיקה</Button>
          <Button variant="danger-ghost">
            <TrashIcon className="size-4.5" />
            לסל
          </Button>
        </Row>
        <Row>
          <Button size="sm">קטן</Button>
          <Button disabled>מושבת</Button>
          <Button loading>שומרים…</Button>
          <Button variant="secondary" loading>
            טוען
          </Button>
          <span className={buttonClasses("primary", "md", "outline-2 outline-offset-2 outline-accent")}>במיקוד</span>
        </Row>
        <Row>
          <IconButton label="עריכה" icon={<PencilIcon className="size-5" />} />
          <IconButton label="הוספה" variant="secondary" icon={<PlusIcon className="size-5" />} />
          <IconButton label="מחיקה" variant="danger-ghost" icon={<TrashIcon className="size-5" />} />
          <IconButton label="מושבת" disabled icon={<PencilIcon className="size-5" />} />
        </Row>
      </Section>

      <Section title="שדות">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="שם מלא" name={p("name")} placeholder="לדוגמה: דנה כהן" />
          <TextField label="טלפון" name={p("phone")} dir="ltr" defaultValue="052-1234567" hint="מספר נייד או קווי" />
          <TextField label="דוא״ל" name={p("email")} dir="ltr" defaultValue="dana@" error="כתובת הדוא״ל לא תקינה" required />
          <TextField label="מושבת" name={p("disabled")} defaultValue="לא ניתן לשינוי" disabled />
          <SelectField label="סטטוס" name={p("status")} defaultValue="new">
            <option value="new">חדש</option>
            <option value="working">בטיפול</option>
          </SelectField>
          <DateField label="תאריך יעד" name={p("due")} value={day} onChange={setDay} hint="השבוע מתחיל ביום ראשון" />
          <DateField label="תאריך ריק" name={p("empty")} />
          <DateField label="תאריך עם שגיאה" name={p("bad")} error="יש לבחור תאריך" required />
          <TextareaField label="הערה" name={p("note")} className="sm:col-span-2" />
        </div>
        <div className="flex flex-col gap-2">
          <Checkbox label="לשלוח תזכורת" name={p("remind")} defaultChecked />
          <Checkbox label="לא מסומן, עם הסבר" name={p("other")} hint="ההסבר מופיע מתחת לתווית" />
          <Checkbox label="מושבת" name={p("off")} disabled />
          <Switch label={on ? "התראות פעילות" : "התראות כבויות"} checked={on} onCheckedChange={setOn} />
          <Switch label="מתג מושבת" checked={false} onCheckedChange={() => {}} disabled />
        </div>
      </Section>

      <Section title="תגיות וקישור">
        <Row>
          <Badge>ניטרלי</Badge>
          <Badge tone="accent">חדש</Badge>
          <Badge tone="success">נסגר בהצלחה</Badge>
          <Badge tone="warning">באיחור</Badge>
          <Badge tone="danger">אבוד</Badge>
          <TextLink href="#">קישור בטקסט</TextLink>
        </Row>
      </Section>

      <Section title="הודעות">
        <FormError message="לא הצלחנו לשמור. נסו שוב." />
        <FormNotice message="השינויים נשמרו." />
        <ToastView message="הליד נשמר" tone="success" onClose={() => {}} />
        <ToastView message="אין הרשאה לפעולה הזו" tone="error" onClose={() => {}} />
        <Row>
          <Button variant="secondary" onClick={() => toast("נשמר")}>
            הודעה צפה
          </Button>
          <Button variant="secondary" onClick={() => toast("משהו השתבש", "error")}>
            הודעת שגיאה צפה
          </Button>
        </Row>
      </Section>

      <Section title="חלון, מגירה, חלון קופץ ואישור">
        <Row>
          <Button variant="secondary" onClick={() => setDialog("dialog")}>
            פתיחת חלון
          </Button>
          <Button variant="secondary" onClick={() => setDialog("sheet")}>
            פתיחת מגירה
          </Button>
          <Popover
            label="התראות"
            triggerLabel="התראות"
            trigger={<BellIcon className="size-5" />}
            triggerClassName={iconButtonClasses("ghost")}
          >
            {(close) => (
              <div className="p-4">
                <p className="font-medium">התראות</p>
                <p className="mt-1 text-sm text-ink-soft">החלון נצמד לשולי המסך בטלפון.</p>
                <Button size="sm" variant="secondary" className="mt-3" onClick={close}>
                  סגירה
                </Button>
              </div>
            )}
          </Popover>
          <ConfirmButton title="להעביר את הליד לסל המחזור?" description="אפשר לשחזר משם במשך 30 יום." confirmLabel="כן, להעביר" action={ok} onDone={() => toast("הועבר לסל")}>
            אישור שמצליח
          </ConfirmButton>
          <ConfirmButton title="להעביר את הליד לסל המחזור?" confirmLabel="כן, להעביר" action={failing}>
            אישור שנכשל
          </ConfirmButton>
        </Row>
        <Dialog
          open={dialog !== null}
          onClose={() => setDialog(null)}
          variant={dialog ?? "dialog"}
          title={dialog === "sheet" ? "מגירה תחתונה" : "חלון"}
          description="Escape או לחיצה מחוץ לחלון סוגרים אותו."
          footer={
            <>
              <Button variant="secondary" onClick={() => setDialog(null)}>
                ביטול
              </Button>
              <Button onClick={() => setDialog(null)}>שמירה</Button>
            </>
          }
        >
          <TextField label="שם" name={p("dialog-name")} />
        </Dialog>
      </Section>

      <Section title="מיקוד אחרי מחיקה (FXA-08)">
        <FocusSample />
      </Section>

      <Section title="שינויים שלא נשמרו">
        <UnsavedSample prefix={p("unsaved")} />
      </Section>

      <Section title="בורר תאריך">
        <Card className="max-w-sm p-4">
          <Calendar selected={day} today="2026-10-09" onPick={setDay} onClear={() => setDay("")} />
        </Card>
      </Section>

      <Section title="חגים ביומן">
        <div className="grid max-w-md grid-cols-4 gap-1">
          {["2026-09-12", "2026-09-20", "2026-12-05", "2026-04-21"].map((cell) => (
            <div key={cell} className="min-h-16 min-w-0 rounded-md border border-line bg-surface p-1">
              <p className="text-caption text-ink-soft">{Number(cell.slice(8, 10))}</p>
              <HolidayMarks holidays={holidaysOn(cell)} compact />
            </div>
          ))}
        </div>
        <HolidayMarks holidays={holidaysOn("2026-04-22")} className="max-w-xs" />
        <HolidayLegend />
      </Section>

      <Section title="כרטיס, טבלה וכרטיסי רשימה">
        <Card>
          <CardHeader title="כרטיס" action={<Button size="sm">פעולה</Button>} />
          <CardBody>תוכן הכרטיס.</CardBody>
        </Card>
        <Table caption="לידים">
          <thead>
            <tr>
              <Th>שם</Th>
              <Th>טלפון</Th>
              <Th>סטטוס</Th>
            </tr>
          </thead>
          <tbody>
            <Tr>
              <Td>דנה כהן</Td>
              <Td dir="ltr" className="text-end">
                052-1234567
              </Td>
              <Td>
                <Badge tone="accent">חדש</Badge>
              </Td>
            </Tr>
            <Tr>
              <Td>יוסי לוי</Td>
              <Td dir="ltr" className="text-end">
                03-7654321
              </Td>
              <Td>
                <Badge tone="warning">בטיפול</Badge>
              </Td>
            </Tr>
          </tbody>
        </Table>
        <ListCards label="לידים">
          <ListCard href="#" title="דנה כהן" subtitle={<span dir="ltr">052-1234567</span>} meta={<Badge tone="accent">חדש</Badge>} />
          <ListCard href="#" title="שם ארוך מאוד של חברה שלא נכנס בשורה אחת בטלפון" subtitle="יוסי לוי" meta={<Badge tone="warning">בטיפול</Badge>} />
        </ListCards>
      </Section>

      <Section title="סידור">
        <ul className="flex flex-col gap-1">
          {items.map((item, i) => (
            <li key={item} className="flex items-center justify-between rounded-md border border-line bg-surface ps-3">
              {item}
              <ReorderButtons name={item} first={i === 0} last={i === items.length - 1} onMove={(d) => move(i, d)} />
            </li>
          ))}
        </ul>
      </Section>

      <Section title="מצב ריק וטעינה">
        <Card>
          <EmptyState icon={<Icons.InboxIcon />} title="עוד אין לידים" description="לידים מטפסים, מייבוא או מהוספה ידנית יופיעו כאן." action={<Button>הוספת ליד</Button>} />
        </Card>
        <div className="grid gap-3 sm:grid-cols-3">
          <Card>
            <EmptyState compact kind="search" title="לא נמצאו לידים" description="נסו מילה אחרת או נקו את הסינון." />
          </Card>
          <Card>
            <EmptyState compact kind="locked" title="אין גישה" description="המסך הזה פתוח למנהלים." />
          </Card>
          <Card>
            <EmptyState compact kind="done" title="אין משימות פתוחות להיום" />
          </Card>
        </div>
        <Skeleton className="h-6 w-40" />
        <ListSkeleton rows={2} />
      </Section>

      <Section title="מיתוג העסק בדפי הלקוח (FLD-04)">
        <p className="text-sm text-ink-soft">
          הצבע של העסק מחליף את צבע ההדגשה רק בדפים שהלקוח רואה. צבע שלא עומד בניגודיות 4.5:1 מתוקן לגוון הקרוב שעומד.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {BRAND_SAMPLES.map((color) => (
            <BrandScope key={color} color={color}>
              <Card className="flex flex-col gap-3 p-4">
                <OrgLogo url={sampleLogo.src} alt="לוגו לדוגמה" className="h-6 max-w-32" />
                <p className="text-sm text-ink-soft">
                  נבחר <span dir="ltr">{color}</span>
                  {brandPalette(color, theme).corrected ? " · תוקן לקריאות" : ""}
                </p>
                <TextField label="שם מלא" name={p(`brand-${color}`)} defaultValue="דנה כהן" />
                <Row>
                  <Button size="sm">שליחת הפרטים</Button>
                  <TextLink href="#">קישור</TextLink>
                  <Badge tone="accent">תגית</Badge>
                </Row>
              </Card>
            </BrandScope>
          ))}
        </div>
      </Section>
    </div>
  );
}

const FOCUS_SAMPLE_ROWS = ["דנה כהן", "יוסי לוי", "מיכל אברהם"];

/**
 * FXA-08: delete a row with the keyboard; focus moves to the next row (else the previous one, else the page heading),
 * never back to the top of the page. "לא עכשיו" gives focus back to the button that asked.
 */
function FocusSample() {
  const [rows, setRows] = useState(FOCUS_SAMPLE_ROWS);
  const remove = (name: string) => async () => {
    setRows((list) => list.filter((row) => row !== name));
    return { ok: true as const };
  };
  return (
    <div className="flex max-w-xl flex-col gap-3">
      <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
        {rows.map((name) => (
          <li key={name} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <span>{name}</span>
            <span className="flex flex-wrap gap-2">
              <ActionButton action={remove(name)} pendingText="מוחקים…" variant="danger-ghost" confirm="למחוק את השורה?" srLabel={name}>
                מחיקה
              </ActionButton>
              <ConfirmButton title={`להעביר את ${name} לסל המחזור?`} confirmLabel="כן, להעביר" action={remove(name)}>
                לסל המחזור
              </ConfirmButton>
            </span>
          </li>
        ))}
      </ul>
      {rows.length < FOCUS_SAMPLE_ROWS.length ? (
        <Button variant="secondary" size="sm" className="self-start" onClick={() => setRows(FOCUS_SAMPLE_ROWS)}>
          החזרת השורות
        </Button>
      ) : null}
    </div>
  );
}

/** REC-11: a guarded form; change the name and follow the link, or open the warning itself. */
function UnsavedSample({ prefix }: { prefix: string }) {
  const [saved, setSaved] = useState<{ ok: true } | null>(null);
  const [asking, setAsking] = useState(false);
  return (
    <Card className="max-w-sm p-4">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setSaved({ ok: true });
        }}
      >
        <FormGuard state={saved} />
        <TextField label="שם" name={`${prefix}-name`} defaultValue="דנה כהן" hint="שנו את השם ולחצו על הקישור: נשאל לפני היציאה." />
        <TextLink href="/admin" className="self-start">מעבר לדף אחר</TextLink>
        <Row>
          <Button type="submit" size="sm">
            שמירה
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setAsking(true)}>
            הצגת האזהרה
          </Button>
        </Row>
      </form>
      {asking ? <LeaveDialog onStay={() => setAsking(false)} onLeave={() => setAsking(false)} /> : null}
    </Card>
  );
}

# FXD-06: מחיקה לילית של התראות ישנות וריקון סל המחזור במנות

הקובץ הזה מיועד להדבקה ידנית ב-SQL Editor של Supabase. הסיבה: החיבור האוטומטי נעצר על קובץ שיש בו פקודת מחיקה.

## מה זה עושה

- **התראות:** התראה שנקראה נמחקת 90 יום אחרי שנוצרה, והתראה שלא נקראה נמחקת אחרי 180 יום. כך החלטת ב-18 באוקטובר. יומן הפעולות לא נמחק, והעובדות נשארות בו.
- **סל המחזור:** הכלל לא משתנה. מה שנמצא בסל 30 יום נמחק כמו קודם, אבל עכשיו במנות של עד 1,000 רשומות מכל סוג בכל הרצה, במקום הכל בבת אחת. כך מחיקה גדולה לא תוקעת את המסד. (זה הממצא מהסקירה, "ריקון הסל במנות".)
- **מתי זה רץ:** שתי המשימות רצות כל רבע שעה בין 01:00 ל-04:45 UTC, כלומר בלילה בשעון ישראל. בכל לילה נמחקות עד 80,000 התראות ועד 16,000 רשומות מכל סוג בסל.

## לפני ההדבקה

המיגרציה `20261006020352_notification_retention_index` צריכה כבר לרוץ (המוביל מריץ אותה בחיבור הרגיל). היא מוסיפה אינדקס לפי תאריך יצירת ההתראה.

אפשר לבדוק שהיא רצה (קריאה בלבד):

```sql
select indexname from pg_indexes where indexname = 'notifications_created_idx';
```

אמורה לחזור שורה אחת.

## מה להדביק

את הקובץ `supabase/migrations/20261006020355_retention_purge.sql`. הוא ארוך מדי להדבקה אחת, ולכן מחולק לשני חלקים:

1. `supabase/handoff/20261006020355_retention_purge/part1.sql`: מדביקים ולוחצים Run.
2. `supabase/handoff/20261006020355_retention_purge/part2.sql`: מדביקים ולוחצים Run.

חשוב לשמור על הסדר. אפשר להריץ שוב בלי נזק.

## איך נראית הצלחה

בכל חלק כתוב "Success. No rows returned". אם מופיעה שגיאה, לא ממשיכים, ושולחים לי את הטקסט שלה.

## איך בודקים אחרי ההדבקה (קריאה בלבד)

הפונקציות קיימות:

```sql
select proname from pg_proc
 where pronamespace = 'app'::regnamespace and proname in ('purge_old_notifications', 'purge_trash');
```

אמורות לחזור שתי שורות.

המשימות המתוזמנות קיימות:

```sql
select jobname, schedule, command from cron.job
 where jobname in ('crm-purge-notifications', 'crm-purge-trash');
```

אמורות לחזור שתי שורות, ובשתיהן `*/15 1-4 * * *`.

כמה התראות ממתינות למחיקה:

```sql
select count(*) from public.notifications
 where created_at < now() - interval '90 days'
   and (read_at is not null or created_at < now() - interval '180 days');
```

אחרי הלילה הראשון בודקים שהריצות הצליחו:

```sql
select j.jobname, d.status, d.return_message, d.start_time
  from cron.job_run_details d join cron.job j on j.jobid = d.jobid
 where j.jobname in ('crm-purge-notifications', 'crm-purge-trash')
 order by d.start_time desc limit 10;
```

בעמודה `status` אמור להופיע `succeeded`.

כשסיימת, כתוב לי "הרצתי".

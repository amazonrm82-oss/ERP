-- VRT-01: industry kits (owner (274) א + ב: the first two kits are clinics and studios & courses). Extends FLD-05.
-- * app.industry_kit(key): the kits as data, 'clinic' and 'studio'; null for any other key. Each is
--   {template, products, meeting_types, message_templates, whatsapp_templates, form, views}, where template has the shape
--   of app.industry_template(). It mirrors INDUSTRY_KITS in src/features/industry-templates/kits.ts;
--   tests/db/65-industry-templates.test.ts keeps the two equal. app.industry_template_products() is not changed;
--   app.industry_template() is redefined only for owner (350) ג (below).
-- * public.apply_industry_template(org, industry): same signature and every FLD-05 behaviour of 020605 (owners/admins of a
--   writable organization; adds only what is missing; names compared with btrim(); never deletes, renames, reorders
--   beyond the FLD-05 stage/status placing, or changes an existing row; an item over a plan limit is skipped and reported;
--   the key is recorded in organizations.industry_templates only when nothing was cut). For a kit key, the template part
--   comes from the kit and its products replace app.industry_template_products(), and these steps follow:
--     products       with the 'products' flag: services as in FLD-05; a punch card product only with the 'punch_cards'
--                    key as well (otherwise skipped, not reported), added AFTER the meeting types so it names the kit's
--                    meeting type when the business has one of that name (lower(btrim)), else none
--     meeting types  skipped when a type of that name exists (lower(btrim), the table's unique index), position after the
--                    last; linked to the kit's product by name only with the 'products' flag and while it is offerable;
--                    the 50 cap (hint meeting_types:max) is reported
--     message templates (MSG-02) marketing only (a service template of a type with its own sender, such as CAL-12's
--                    meeting reminders, is the system's own by notice_kind: a kit copy could never be sent and would
--                    take one of the 50 slots); skipped by name (lower(btrim)); DRAFT wording, marked wording_version
--                    'kit-draft-1' (cleared by a person's edit, the 021196 trigger); no offer; the 50 cap
--                    (message_templates:max) is reported
--     WhatsApp templates (WA-01) skipped by name (lower(btrim)); neutral wording (HEB-01); the 50 cap
--                    (whatsapp_templates:max) is reported
--     form           one web form (kind 'form') added SWITCHED OFF, leads to the person who applied, skipped when a form of
--                    that name exists (btrim); a cf:<key> field the business lacks, has inactive, or has of a type public
--                    forms never show (FORM_EXCLUDED_TYPES: user, rich_text, duration, status, record_link, file) is left out;
--                    max_forms (limit:max_forms) is reported
--     views          organization-wide saved views of the leads list (scope 'org', owner = the person who applied),
--                    filtered by the kit's lead status of that name; skipped when an org lead view of that name exists
--                    (btrim) or the status is missing
--   The clinics kit holds no health or medical content (no such field, no health declaration template; tests check a
--   closed list of medical words). The answer's "added" gains meeting_types, message_templates, whatsapp_templates, forms
--   and views (0 for a FLD-05 template).
-- Every statement is safe to run twice. No drop statement, no row removal.

-- Owner (350) ג: the FLD-05 "health" template body of 010700 with one change: its field "קופת חולים" carries
-- "privacy_class": "sensitive" (PRK-01), written by apply_industry_template on a NEW field only (no backfill). A template
-- field may carry privacy_class (null|personal|sensitive); TemplateField in templates.ts mirrors it (test 65).
create or replace function app.industry_template(p_industry text) returns jsonb
language sql immutable
set search_path = ''
as $fn$
  select case p_industry
    when 'services' then $tpl${
      "industry": "services",
      "title": "שירותים מקצועיים וייעוץ",
      "pipeline": {"name": "ליווי וייעוץ", "stages": [
          {"name":"פנייה","kind":"open","probability":10,"rot_days":7},
          {"name":"פגישת אבחון","kind":"open","probability":25,"rot_days":7},
          {"name":"הצעת מחיר","kind":"open","probability":50,"rot_days":14},
          {"name":"חתימה על הסכם","kind":"open","probability":80,"rot_days":14},
          {"name":"לקוח פעיל","kind":"won","probability":100,"rot_days":null},
          {"name":"לא התקדם","kind":"lost","probability":0,"rot_days":null}
        ]},
      "statuses": ["נקבעה פגישת אבחון","ממתין להחלטה"],
      "sources": ["המלצה של לקוח","לינקדאין"],
      "fields": [
        {"object_type":"lead","key":"service_needed","label":"שירות מבוקש","field_type":"select","options":["ייעוץ חד-פעמי","ליווי חודשי","סדנה"]},
        {"object_type":"deal","key":"engagement_type","label":"סוג התקשרות","field_type":"select","options":["לפי שעות","ריטיינר חודשי","פרויקט"]},
        {"object_type":"deal","key":"hours_estimate","label":"הערכת שעות","field_type":"number","options":[]}
      ],
      "automations": [
        {"key":"new_lead_call","name":"ליד חדש: לחזור תוך 15 דקות","entity_type":"lead","trigger_type":"created","trigger_config":{},"actions":[{"type":"create_task","title":"להתקשר ל{{name}}","task_type":"call","assign":"owner","due_in_minutes":15}]},
        {"key":"stuck_deal","name":"עסקה תקועה 14 ימים","entity_type":"deal","trigger_type":"stuck_in_stage","trigger_config":{"days":14},"actions":[{"type":"notify","to":"owner","title":"העסקה {{name}} לא זזה שבועיים"}]}
      ]
    }$tpl$::jsonb
    when 'real_estate' then $tpl${
      "industry": "real_estate",
      "title": "נדל\"ן ותיווך",
      "pipeline": {"name": "עסקאות נדל\"ן", "stages": [
          {"name":"פנייה ראשונה","kind":"open","probability":10,"rot_days":3},
          {"name":"סיור בנכס","kind":"open","probability":30,"rot_days":7},
          {"name":"משא ומתן","kind":"open","probability":60,"rot_days":14},
          {"name":"זיכרון דברים","kind":"open","probability":80,"rot_days":14},
          {"name":"חוזה נחתם","kind":"won","probability":100,"rot_days":null},
          {"name":"לא נסגר","kind":"lost","probability":0,"rot_days":null}
        ]},
      "statuses": ["נקבע סיור","מחפש נכס"],
      "sources": ["יד2","שלט על הנכס"],
      "fields": [
        {"object_type":"lead","key":"deal_type","label":"סוג עסקה","field_type":"select","options":["קנייה","מכירה","השכרה","שכירות"]},
        {"object_type":"lead","key":"property_type","label":"סוג נכס","field_type":"select","options":["דירה","דירת גן","בית פרטי","פנטהאוז","מסחרי","מגרש"]},
        {"object_type":"lead","key":"rooms","label":"מספר חדרים","field_type":"number","options":[]},
        {"object_type":"lead","key":"area","label":"אזור מבוקש","field_type":"text","options":[]},
        {"object_type":"deal","key":"commission","label":"עמלה","field_type":"percent","options":[]}
      ],
      "automations": [
        {"key":"new_lead_call","name":"ליד חדש: לחזור תוך 15 דקות","entity_type":"lead","trigger_type":"created","trigger_config":{},"actions":[{"type":"create_task","title":"להתקשר ל{{name}}","task_type":"call","assign":"owner","due_in_minutes":15}]},
        {"key":"stuck_deal","name":"עסקה תקועה 14 ימים","entity_type":"deal","trigger_type":"stuck_in_stage","trigger_config":{"days":14},"actions":[{"type":"notify","to":"owner","title":"העסקה {{name}} לא זזה שבועיים"}]}
      ]
    }$tpl$::jsonb
    when 'insurance_finance' then $tpl${
      "industry": "insurance_finance",
      "title": "ביטוח ופיננסים",
      "pipeline": {"name": "פוליסות", "stages": [
          {"name":"פנייה","kind":"open","probability":10,"rot_days":7},
          {"name":"איסוף מסמכים","kind":"open","probability":25,"rot_days":14},
          {"name":"בדיקת הצעות","kind":"open","probability":45,"rot_days":14},
          {"name":"הצגת הצעה","kind":"open","probability":70,"rot_days":14},
          {"name":"פוליסה הופקה","kind":"won","probability":100,"rot_days":null},
          {"name":"לא נסגר","kind":"lost","probability":0,"rot_days":null}
        ]},
      "statuses": ["ממתין למסמכים","נשלחה הצעה"],
      "sources": ["המלצה של לקוח","פרסום מקומי"],
      "fields": [
        {"object_type":"lead","key":"insurance_type","label":"סוג ביטוח","field_type":"multi_select","options":["חיים","בריאות","רכב","דירה","פנסיה","עסק"]},
        {"object_type":"deal","key":"renewal_date","label":"תאריך חידוש","field_type":"date","options":[]},
        {"object_type":"deal","key":"monthly_premium","label":"פרמיה חודשית","field_type":"currency","options":[]}
      ],
      "automations": [
        {"key":"new_lead_call","name":"ליד חדש: לחזור תוך 15 דקות","entity_type":"lead","trigger_type":"created","trigger_config":{},"actions":[{"type":"create_task","title":"להתקשר ל{{name}}","task_type":"call","assign":"owner","due_in_minutes":15}]},
        {"key":"won_follow_up","name":"פוליסה הופקה: שיחת מעקב","entity_type":"deal","trigger_type":"deal_won","trigger_config":{},"actions":[{"type":"create_task","title":"לוודא עם {{name}} שהפוליסה התקבלה","task_type":"call","assign":"owner","due_in_days":7}]}
      ]
    }$tpl$::jsonb
    when 'construction' then $tpl${
      "industry": "construction",
      "title": "בנייה, שיפוצים והתקנות",
      "pipeline": {"name": "פרויקטים", "stages": [
          {"name":"פנייה","kind":"open","probability":10,"rot_days":3},
          {"name":"ביקור ומדידות","kind":"open","probability":25,"rot_days":7},
          {"name":"הצעת מחיר","kind":"open","probability":50,"rot_days":14},
          {"name":"חתימה ומקדמה","kind":"open","probability":80,"rot_days":14},
          {"name":"בביצוע","kind":"open","probability":90,"rot_days":null},
          {"name":"הסתיים","kind":"won","probability":100,"rot_days":null},
          {"name":"לא יצא לפועל","kind":"lost","probability":0,"rot_days":null}
        ]},
      "statuses": ["נקבע ביקור","ממתין להצעה"],
      "sources": ["שלט באתר עבודה","המלצה של לקוח"],
      "fields": [
        {"object_type":"lead","key":"work_type","label":"סוג עבודה","field_type":"select","options":["שיפוץ כללי","מטבח","חדר רחצה","איטום","חשמל","אינסטלציה"]},
        {"object_type":"lead","key":"site_address","label":"כתובת העבודה","field_type":"text","options":[]},
        {"object_type":"deal","key":"start_date","label":"מועד התחלה","field_type":"date","options":[]},
        {"object_type":"deal","key":"deposit_paid","label":"שולמה מקדמה","field_type":"checkbox","options":[]}
      ],
      "automations": [
        {"key":"new_lead_call","name":"ליד חדש: לחזור תוך 15 דקות","entity_type":"lead","trigger_type":"created","trigger_config":{},"actions":[{"type":"create_task","title":"להתקשר ל{{name}}","task_type":"call","assign":"owner","due_in_minutes":15}]},
        {"key":"won_follow_up","name":"פרויקט הסתיים: בקשת חוות דעת","entity_type":"deal","trigger_type":"deal_won","trigger_config":{},"actions":[{"type":"create_task","title":"לבקש חוות דעת על {{name}}","task_type":"follow_up","assign":"owner","due_in_days":7}]}
      ]
    }$tpl$::jsonb
    when 'retail' then $tpl${
      "industry": "retail",
      "title": "מסחר וקמעונאות",
      "pipeline": {"name": "הזמנות", "stages": [
          {"name":"התעניינות","kind":"open","probability":10,"rot_days":3},
          {"name":"הצעה נשלחה","kind":"open","probability":40,"rot_days":7},
          {"name":"הזמנה התקבלה","kind":"open","probability":80,"rot_days":7},
          {"name":"נשלח ללקוח","kind":"open","probability":90,"rot_days":7},
          {"name":"נמסר","kind":"won","probability":100,"rot_days":null},
          {"name":"בוטל","kind":"lost","probability":0,"rot_days":null}
        ]},
      "statuses": ["ביקש הצעת מחיר"],
      "sources": ["אינסטגרם","חנות"],
      "fields": [
        {"object_type":"lead","key":"product_interest","label":"מוצר מבוקש","field_type":"text","options":[]},
        {"object_type":"contact","key":"customer_club","label":"חבר מועדון","field_type":"checkbox","options":[]},
        {"object_type":"deal","key":"delivery_method","label":"אופן מסירה","field_type":"select","options":["איסוף עצמי","שליח","דואר"]}
      ],
      "automations": [
        {"key":"new_lead_call","name":"ליד חדש: לחזור תוך 15 דקות","entity_type":"lead","trigger_type":"created","trigger_config":{},"actions":[{"type":"create_task","title":"להתקשר ל{{name}}","task_type":"call","assign":"owner","due_in_minutes":15}]},
        {"key":"won_follow_up","name":"הזמנה נמסרה: שיחת מעקב","entity_type":"deal","trigger_type":"deal_won","trigger_config":{},"actions":[{"type":"create_task","title":"לבדוק שההזמנה {{name}} הגיעה תקינה","task_type":"call","assign":"owner","due_in_days":3}]}
      ]
    }$tpl$::jsonb
    when 'health' then $tpl${
      "industry": "health",
      "title": "בריאות, טיפול וקליניקות",
      "pipeline": {"name": "טיפולים", "stages": [
          {"name":"פנייה","kind":"open","probability":10,"rot_days":3},
          {"name":"שיחת התאמה","kind":"open","probability":30,"rot_days":7},
          {"name":"נקבע טיפול ראשון","kind":"open","probability":60,"rot_days":7},
          {"name":"בסדרת טיפולים","kind":"open","probability":80,"rot_days":30},
          {"name":"הסתיים","kind":"won","probability":100,"rot_days":null},
          {"name":"לא המשיך","kind":"lost","probability":0,"rot_days":null}
        ]},
      "statuses": ["נקבע תור","ממתין לתור"],
      "sources": ["גוגל","הפניה מגורם מקצועי"],
      "fields": [
        {"object_type":"lead","key":"treatment_type","label":"סוג טיפול","field_type":"select","options":["פגישה ראשונה","המשך טיפול","ייעוץ"]},
        {"object_type":"contact","key":"health_fund","label":"קופת חולים","field_type":"select","options":["כללית","מכבי","מאוחדת","לאומית"],"privacy_class":"sensitive"},
        {"object_type":"deal","key":"sessions_count","label":"מספר מפגשים","field_type":"number","options":[]}
      ],
      "automations": [
        {"key":"new_lead_call","name":"ליד חדש: לחזור תוך 15 דקות","entity_type":"lead","trigger_type":"created","trigger_config":{},"actions":[{"type":"create_task","title":"להתקשר ל{{name}}","task_type":"call","assign":"owner","due_in_minutes":15}]},
        {"key":"won_follow_up","name":"סדרת טיפולים הסתיימה: מעקב","entity_type":"deal","trigger_type":"deal_won","trigger_config":{},"actions":[{"type":"create_task","title":"שיחת מעקב אחרי {{name}}","task_type":"call","assign":"owner","due_in_days":14}]}
      ]
    }$tpl$::jsonb
    when 'education' then $tpl${
      "industry": "education",
      "title": "חינוך והדרכה",
      "pipeline": {"name": "הרשמה", "stages": [
          {"name":"פנייה","kind":"open","probability":10,"rot_days":3},
          {"name":"שיחת ייעוץ","kind":"open","probability":30,"rot_days":7},
          {"name":"שיעור ניסיון","kind":"open","probability":50,"rot_days":7},
          {"name":"ממתין לתשלום","kind":"open","probability":80,"rot_days":7},
          {"name":"נרשם","kind":"won","probability":100,"rot_days":null},
          {"name":"לא נרשם","kind":"lost","probability":0,"rot_days":null}
        ]},
      "statuses": ["נקבע שיעור ניסיון"],
      "sources": ["אינסטגרם","יום פתוח"],
      "fields": [
        {"object_type":"lead","key":"course","label":"קורס מבוקש","field_type":"text","options":[]},
        {"object_type":"lead","key":"learning_format","label":"אופן לימוד","field_type":"select","options":["פרונטלי","מקוון","משולב"]},
        {"object_type":"contact","key":"parent_name","label":"שם הורה","field_type":"text","options":[]}
      ],
      "automations": [
        {"key":"new_lead_call","name":"ליד חדש: לחזור תוך 15 דקות","entity_type":"lead","trigger_type":"created","trigger_config":{},"actions":[{"type":"create_task","title":"להתקשר ל{{name}}","task_type":"call","assign":"owner","due_in_minutes":15}]},
        {"key":"won_follow_up","name":"נרשם: פרטי פתיחה","entity_type":"deal","trigger_type":"deal_won","trigger_config":{},"actions":[{"type":"create_task","title":"לשלוח פרטי פתיחה על {{name}}","task_type":"todo","assign":"owner","due_in_days":1}]}
      ]
    }$tpl$::jsonb
    when 'marketing' then $tpl${
      "industry": "marketing",
      "title": "שיווק, פרסום ודיגיטל",
      "pipeline": {"name": "לקוחות סוכנות", "stages": [
          {"name":"פנייה","kind":"open","probability":10,"rot_days":3},
          {"name":"פגישת היכרות","kind":"open","probability":25,"rot_days":7},
          {"name":"בריף","kind":"open","probability":40,"rot_days":14},
          {"name":"הצעה","kind":"open","probability":60,"rot_days":14},
          {"name":"ריטיינר נחתם","kind":"won","probability":100,"rot_days":null},
          {"name":"לא נסגר","kind":"lost","probability":0,"rot_days":null}
        ]},
      "statuses": ["נקבעה פגישה"],
      "sources": ["לינקדאין","המלצה של לקוח"],
      "fields": [
        {"object_type":"lead","key":"services_needed","label":"שירותים מבוקשים","field_type":"multi_select","options":["ניהול קמפיינים","רשתות חברתיות","בניית אתר","קידום אורגני","מיתוג"]},
        {"object_type":"deal","key":"monthly_budget","label":"תקציב פרסום חודשי","field_type":"currency","options":[]},
        {"object_type":"deal","key":"contract_months","label":"תקופת התקשרות בחודשים","field_type":"number","options":[]}
      ],
      "automations": [
        {"key":"new_lead_call","name":"ליד חדש: לחזור תוך 15 דקות","entity_type":"lead","trigger_type":"created","trigger_config":{},"actions":[{"type":"create_task","title":"להתקשר ל{{name}}","task_type":"call","assign":"owner","due_in_minutes":15}]},
        {"key":"stuck_deal","name":"עסקה תקועה 14 ימים","entity_type":"deal","trigger_type":"stuck_in_stage","trigger_config":{"days":14},"actions":[{"type":"notify","to":"owner","title":"העסקה {{name}} לא זזה שבועיים"}]}
      ]
    }$tpl$::jsonb
    when 'technology' then $tpl${
      "industry": "technology",
      "title": "טכנולוגיה ותוכנה",
      "pipeline": {"name": "מכירות תוכנה", "stages": [
          {"name":"פנייה","kind":"open","probability":10,"rot_days":7},
          {"name":"הדגמה","kind":"open","probability":30,"rot_days":14},
          {"name":"תקופת ניסיון","kind":"open","probability":50,"rot_days":30},
          {"name":"הצעת מחיר","kind":"open","probability":70,"rot_days":14},
          {"name":"נחתם","kind":"won","probability":100,"rot_days":null},
          {"name":"אבוד","kind":"lost","probability":0,"rot_days":null}
        ]},
      "statuses": ["נקבעה הדגמה"],
      "sources": ["לינקדאין","אתר השוואות"],
      "fields": [
        {"object_type":"lead","key":"users_count","label":"מספר משתמשים","field_type":"number","options":[]},
        {"object_type":"deal","key":"license_type","label":"סוג רישוי","field_type":"select","options":["חודשי","שנתי","חד-פעמי"]},
        {"object_type":"deal","key":"renewal_date","label":"תאריך חידוש","field_type":"date","options":[]}
      ],
      "automations": [
        {"key":"new_lead_call","name":"ליד חדש: לחזור תוך 15 דקות","entity_type":"lead","trigger_type":"created","trigger_config":{},"actions":[{"type":"create_task","title":"להתקשר ל{{name}}","task_type":"call","assign":"owner","due_in_minutes":15}]},
        {"key":"stuck_deal","name":"עסקה תקועה 14 ימים","entity_type":"deal","trigger_type":"stuck_in_stage","trigger_config":{"days":14},"actions":[{"type":"notify","to":"owner","title":"העסקה {{name}} לא זזה שבועיים"}]}
      ]
    }$tpl$::jsonb
    when 'tourism_events' then $tpl${
      "industry": "tourism_events",
      "title": "תיירות ואירועים",
      "pipeline": {"name": "אירועים", "stages": [
          {"name":"פנייה","kind":"open","probability":10,"rot_days":3},
          {"name":"בדיקת תאריך","kind":"open","probability":25,"rot_days":7},
          {"name":"הצעת מחיר","kind":"open","probability":50,"rot_days":7},
          {"name":"מקדמה שולמה","kind":"open","probability":85,"rot_days":null},
          {"name":"האירוע התקיים","kind":"won","probability":100,"rot_days":null},
          {"name":"לא נסגר","kind":"lost","probability":0,"rot_days":null}
        ]},
      "statuses": ["ממתין לאישור תאריך"],
      "sources": ["אינסטגרם","אתר אירועים"],
      "fields": [
        {"object_type":"lead","key":"event_date","label":"תאריך האירוע","field_type":"date","options":[]},
        {"object_type":"lead","key":"event_type","label":"סוג אירוע","field_type":"select","options":["חתונה","בר או בת מצווה","אירוע חברה","יום הולדת","טיול"]},
        {"object_type":"lead","key":"guests","label":"מספר משתתפים","field_type":"number","options":[]}
      ],
      "automations": [
        {"key":"new_lead_call","name":"ליד חדש: לחזור תוך 15 דקות","entity_type":"lead","trigger_type":"created","trigger_config":{},"actions":[{"type":"create_task","title":"להתקשר ל{{name}}","task_type":"call","assign":"owner","due_in_minutes":15}]},
        {"key":"won_follow_up","name":"אחרי האירוע: בקשת חוות דעת","entity_type":"deal","trigger_type":"deal_won","trigger_config":{},"actions":[{"type":"create_task","title":"לבקש חוות דעת על {{name}}","task_type":"follow_up","assign":"owner","due_in_days":3}]}
      ]
    }$tpl$::jsonb
    when 'nonprofit' then $tpl${
      "industry": "nonprofit",
      "title": "עמותות ומלכ\"רים",
      "pipeline": {"name": "תרומות", "stages": [
          {"name":"פנייה","kind":"open","probability":10,"rot_days":7},
          {"name":"שיחת היכרות","kind":"open","probability":30,"rot_days":14},
          {"name":"בקשה הוגשה","kind":"open","probability":50,"rot_days":30},
          {"name":"התחייבות","kind":"open","probability":80,"rot_days":30},
          {"name":"התרומה התקבלה","kind":"won","probability":100,"rot_days":null},
          {"name":"לא תרם","kind":"lost","probability":0,"rot_days":null}
        ]},
      "statuses": ["מעוניין לתרום","מעוניין להתנדב"],
      "sources": ["אירוע התרמה","מתנדבים"],
      "fields": [
        {"object_type":"contact","key":"donor_type","label":"סוג תורם","field_type":"select","options":["פרטי","חברה","קרן"]},
        {"object_type":"contact","key":"volunteer","label":"מתנדב","field_type":"checkbox","options":[]},
        {"object_type":"deal","key":"receipt_sent","label":"נשלחה קבלה לפי סעיף 46","field_type":"checkbox","options":[]}
      ],
      "automations": [
        {"key":"new_lead_call","name":"ליד חדש: לחזור תוך 15 דקות","entity_type":"lead","trigger_type":"created","trigger_config":{},"actions":[{"type":"create_task","title":"להתקשר ל{{name}}","task_type":"call","assign":"owner","due_in_minutes":15}]},
        {"key":"won_follow_up","name":"תרומה התקבלה: תודה וקבלה","entity_type":"deal","trigger_type":"deal_won","trigger_config":{},"actions":[{"type":"create_task","title":"לשלוח מכתב תודה וקבלה על {{name}}","task_type":"todo","assign":"owner","due_in_days":1}]}
      ]
    }$tpl$::jsonb
    when 'other' then $tpl${
      "industry": "other",
      "title": "כללי",
      "pipeline": null,
      "statuses": ["נקבעה פגישה"],
      "sources": ["גוגל","אינסטגרם"],
      "fields": [
        {"object_type":"lead","key":"interest","label":"במה מתעניין","field_type":"text","options":[]}
      ],
      "automations": [
        {"key":"new_lead_call","name":"ליד חדש: לחזור תוך 15 דקות","entity_type":"lead","trigger_type":"created","trigger_config":{},"actions":[{"type":"create_task","title":"להתקשר ל{{name}}","task_type":"call","assign":"owner","due_in_minutes":15}]},
        {"key":"stuck_deal","name":"עסקה תקועה 14 ימים","entity_type":"deal","trigger_type":"stuck_in_stage","trigger_config":{"days":14},"actions":[{"type":"notify","to":"owner","title":"העסקה {{name}} לא זזה שבועיים"}]}
      ]
    }$tpl$::jsonb

    else null
  end
$fn$;
revoke all on function app.industry_template(text) from public, anon, authenticated;

create or replace function app.industry_kit(p_industry text) returns jsonb
language sql immutable
set search_path = ''
as $fn$
  select case p_industry
    when 'clinic' then $kit${"template":{"industry":"clinic","title":"ערכת קליניקה ומרפאה","pipeline":{"name":"טיפולים בקליניקה","stages":[{"name":"פנייה","kind":"open","probability":10,"rot_days":3},{"name":"שיחת התאמה","kind":"open","probability":30,"rot_days":7},{"name":"נקבע תור ראשון","kind":"open","probability":60,"rot_days":7},{"name":"בסדרת טיפולים","kind":"open","probability":80,"rot_days":30},{"name":"סדרה נסגרה","kind":"won","probability":100,"rot_days":null},{"name":"לא המשיך","kind":"lost","probability":0,"rot_days":null}]},"statuses":["נקבע תור","ממתין לתור","ביקש שיחה חוזרת"],"sources":["גוגל","הפניה מגורם מקצועי","אינסטגרם"],"fields":[{"object_type":"lead","key":"treatment_type","label":"סוג טיפול","field_type":"select","options":["פגישת היכרות","טיפול בודד","סדרת טיפולים"]},{"object_type":"lead","key":"preferred_therapist","label":"מטפל/ת מועדף/ת","field_type":"text","options":[]},{"object_type":"lead","key":"referral_source","label":"מקור הפניה","field_type":"select","options":["איש או אשת מקצוע","חברים ומשפחה","אינטרנט","אחר"]},{"object_type":"contact","key":"preferred_time","label":"זמן מועדף לתור","field_type":"select","options":["בוקר","צהריים","ערב"]},{"object_type":"deal","key":"sessions_count","label":"מספר מפגשים","field_type":"number","options":[]}],"automations":[{"key":"new_lead_call","name":"ליד חדש: לחזור תוך 15 דקות","entity_type":"lead","trigger_type":"created","trigger_config":{},"actions":[{"type":"create_task","title":"להתקשר ל{{name}}","task_type":"call","assign":"owner","due_in_minutes":15}]},{"key":"won_follow_up","name":"סדרה נסגרה: שיחת מעקב","entity_type":"deal","trigger_type":"deal_won","trigger_config":{},"actions":[{"type":"create_task","title":"שיחת מעקב אחרי {{name}}","task_type":"call","assign":"owner","due_in_days":14}]}]},"products":[{"name":"פגישת היכרות","kind":"service","price_agorot":15000,"billing":"one_time","punch":null},{"name":"טיפול","kind":"service","price_agorot":30000,"billing":"one_time","punch":null},{"name":"כרטיסייה ל-10 טיפולים","kind":"punch_card","price_agorot":270000,"billing":"one_time","punch":{"entries":10,"validity_count":6,"validity_unit":"months","meeting_type":"טיפול"}}],"meeting_types":[{"name":"תור ראשון","duration_minutes":45,"meeting_format":"in_person","buffer_before_minutes":0,"buffer_after_minutes":10,"color":"success","product":"פגישת היכרות"},{"name":"טיפול","duration_minutes":50,"meeting_format":"in_person","buffer_before_minutes":0,"buffer_after_minutes":10,"color":"accent","product":"טיפול"},{"name":"שיחת התאמה טלפונית","duration_minutes":15,"meeting_format":"phone","buffer_before_minutes":0,"buffer_after_minutes":0,"color":"warning","product":null}],"message_templates":[{"name":"הזמנה לתור המשך","channel":"whatsapp","message_type":"marketing","subject":null,"body":"שלום {שם פרטי}, עבר זמן מאז הביקור האחרון ב{שם העסק}. רוצים לקבוע תור המשך? אפשר להשיב להודעה או להתקשר: {טלפון העסק}"}],"whatsapp_templates":[{"name":"אישור תור","body":"שלום {שם פרטי}, התור ב{שם העסק} נקבע ל-{תאריך} בשעה {שעה}. נתראה!"},{"name":"תזכורת לתור מחר","body":"שלום {שם פרטי}, תזכורת: מחר בשעה {שעה} יש תור ב{שם העסק}. אם צריך לשנות, כתבו לנו כאן."},{"name":"שיחת מעקב אחרי טיפול","body":"שלום {שם פרטי}, כאן {שם הנציג} מ{שם העסק}. רצינו לשמוע איך היה ואם אפשר לעזור במשהו."}],"form":{"name":"טופס קביעת תור","title":"קביעת תור","intro":"השאירו פרטים ונחזור אליכם לתיאום תור.","submit_label":"שליחה","success_message":"תודה! נחזור אליכם בהקדם לתיאום התור.","fields":[{"key":"full_name","required":true},{"key":"phone","required":true},{"key":"cf:treatment_type","required":false},{"key":"cf:referral_source","required":false},{"key":"message","required":false}]},"views":[{"object_type":"lead","name":"ממתינים לתור","status":"ממתין לתור"},{"object_type":"lead","name":"תורים שנקבעו","status":"נקבע תור"}]}$kit$::jsonb
    when 'studio' then $kit${"template":{"industry":"studio","title":"ערכת סטודיו וקורסים","pipeline":{"name":"הרשמה לסטודיו","stages":[{"name":"פנייה","kind":"open","probability":10,"rot_days":3},{"name":"נקבע שיעור ניסיון","kind":"open","probability":40,"rot_days":7},{"name":"אחרי שיעור ניסיון","kind":"open","probability":60,"rot_days":7},{"name":"ממתין לתשלום","kind":"open","probability":80,"rot_days":7},{"name":"הרשמה הושלמה","kind":"won","probability":100,"rot_days":null},{"name":"לא המשיך","kind":"lost","probability":0,"rot_days":null}]},"statuses":["נקבע שיעור ניסיון","הגיע לשיעור ניסיון","ממתין לפתיחת קבוצה"],"sources":["אינסטגרם","פייסבוק","חבר מביא חבר"],"fields":[{"object_type":"lead","key":"level","label":"רמה","field_type":"select","options":["מתחילים","ממשיכים","מתקדמים"]},{"object_type":"lead","key":"track","label":"מסלול","field_type":"select","options":["שיעורים קבועים","כרטיסייה","קורס","שיעור פרטי"]},{"object_type":"lead","key":"preferred_days","label":"ימים מועדפים","field_type":"multi_select","options":["ראשון","שני","שלישי","רביעי","חמישי","שישי"]},{"object_type":"contact","key":"parent_name","label":"שם הורה","field_type":"text","options":[]},{"object_type":"deal","key":"course_start","label":"תאריך פתיחה","field_type":"date","options":[]}],"automations":[{"key":"new_lead_call","name":"ליד חדש: לחזור תוך 15 דקות","entity_type":"lead","trigger_type":"created","trigger_config":{},"actions":[{"type":"create_task","title":"להתקשר ל{{name}}","task_type":"call","assign":"owner","due_in_minutes":15}]},{"key":"won_follow_up","name":"הרשמה הושלמה: פרטי פתיחה","entity_type":"deal","trigger_type":"deal_won","trigger_config":{},"actions":[{"type":"create_task","title":"לשלוח פרטי פתיחה על {{name}}","task_type":"todo","assign":"owner","due_in_days":1}]}]},"products":[{"name":"שיעור ניסיון","kind":"service","price_agorot":5000,"billing":"one_time","punch":null},{"name":"שיעור בודד","kind":"service","price_agorot":8000,"billing":"one_time","punch":null},{"name":"מנוי חודשי","kind":"service","price_agorot":35000,"billing":"monthly","punch":null},{"name":"קורס מתחילים","kind":"service","price_agorot":120000,"billing":"one_time","punch":null},{"name":"כרטיסייה ל-10 שיעורים","kind":"punch_card","price_agorot":70000,"billing":"one_time","punch":{"entries":10,"validity_count":3,"validity_unit":"months","meeting_type":"שיעור קבוצתי"}}],"meeting_types":[{"name":"שיעור ניסיון","duration_minutes":60,"meeting_format":"in_person","buffer_before_minutes":0,"buffer_after_minutes":0,"color":"success","product":"שיעור ניסיון"},{"name":"שיעור קבוצתי","duration_minutes":60,"meeting_format":"in_person","buffer_before_minutes":0,"buffer_after_minutes":15,"color":"accent","product":"שיעור בודד"},{"name":"שיעור פרטי","duration_minutes":60,"meeting_format":"in_person","buffer_before_minutes":0,"buffer_after_minutes":0,"color":"warning","product":null}],"message_templates":[{"name":"קבוצה חדשה נפתחת","channel":"email","message_type":"marketing","subject":"קבוצה חדשה נפתחת ב{שם העסק}","body":"שלום {שם פרטי},\nאנחנו פותחים קבוצה חדשה ב{שם העסק}. לפרטים ולהרשמה אפשר להשיב למייל הזה או להתקשר: {טלפון העסק}.\n{שם העסק}"}],"whatsapp_templates":[{"name":"אישור שיעור ניסיון","body":"שלום {שם פרטי}, שיעור הניסיון ב{שם העסק} נקבע ל-{תאריך} בשעה {שעה}. נתראה!"},{"name":"תזכורת לשיעור","body":"שלום {שם פרטי}, תזכורת: השיעור ב{שם העסק} ב-{תאריך} בשעה {שעה}. אם אי אפשר להגיע, כתבו לנו כאן."},{"name":"מעקב אחרי שיעור ניסיון","body":"שלום {שם פרטי}, כאן {שם הנציג} מ{שם העסק}. איך היה בשיעור הניסיון? נשמח לספר על המסלולים."}],"form":{"name":"טופס הרשמה לשיעור ניסיון","title":"הרשמה לשיעור ניסיון","intro":"השאירו פרטים ונחזור אליכם לתיאום שיעור ניסיון.","submit_label":"שליחה","success_message":"תודה! נחזור אליכם בהקדם.","fields":[{"key":"full_name","required":true},{"key":"phone","required":true},{"key":"email","required":false},{"key":"cf:level","required":false},{"key":"cf:track","required":false},{"key":"message","required":false}]},"views":[{"object_type":"lead","name":"נקבע שיעור ניסיון","status":"נקבע שיעור ניסיון"},{"object_type":"lead","name":"ממתינים לפתיחת קבוצה","status":"ממתין לפתיחת קבוצה"}]}$kit$::jsonb
    else null
  end
$fn$;
revoke all on function app.industry_kit(text) from public, anon, authenticated;

create or replace function public.apply_industry_template(p_org uuid, p_industry text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_kit jsonb;
  v_t jsonb;
  v_item jsonb;
  v_name text;
  v_pipeline uuid;
  v_pos integer;
  v_hint text;
  v_open jsonb;
  v_closed jsonb;
  v_names text[];
  v_limits text[] := '{}';
  v_pipelines integer := 0;
  v_stages integer := 0;
  v_statuses integer := 0;
  v_sources integer := 0;
  v_fields integer := 0;
  v_automations integer := 0;
  v_products integer := 0;
  v_meeting_types integer := 0;
  v_message_templates integer := 0;
  v_whatsapp_templates integer := 0;
  v_forms integer := 0;
  v_views integer := 0;
  v_has_products boolean;
  v_id uuid;
  v_fields_json jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not app.is_admin(p_org) or not app.org_writable(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- VRT-01: a kit carries its own template part
  v_kit := app.industry_kit(p_industry);
  v_t := coalesce(v_kit -> 'template', app.industry_template(p_industry));
  if v_t is null then
    raise exception 'unknown industry template' using errcode = 'P0001', hint = 'template:unknown';
  end if;

  -- one apply at a time per organization, so two at once cannot both add a name
  perform 1 from public.organizations o where o.id = p_org for no key update;

  -- pipeline and stages
  if jsonb_typeof(v_t -> 'pipeline') = 'object' then
    v_name := v_t -> 'pipeline' ->> 'name';
    select p.id into v_pipeline
      from public.pipelines p
     where p.organization_id = p_org and p.deleted_at is null
       and btrim(p.name) = btrim(v_name)
     order by p.position, p.created_at
     limit 1;
    if v_pipeline is null then
      begin
        insert into public.pipelines (organization_id, name, position, is_default, created_by)
        values (
          p_org, v_name,
          coalesce((select max(p.position) + 1 from public.pipelines p where p.organization_id = p_org), 0),
          false, v_uid)
        returning id into v_pipeline;
        v_pipelines := 1;
      exception when sqlstate 'P0001' then
        get stacked diagnostics v_hint = pg_exception_hint;
        if coalesce(v_hint, '') not like 'limit:%' then
          raise;
        end if;
        v_limits := v_limits || v_hint;
      end;
    end if;

    if v_pipeline is not null then
      -- what is missing, in template order: open stages, then a won / lost stage of a kind the pipeline lacks
      select coalesce(jsonb_agg(e.value order by e.n) filter (where e.value ->> 'kind' = 'open'), '[]'::jsonb),
             coalesce(jsonb_agg(e.value order by e.n) filter (where e.value ->> 'kind' <> 'open'), '[]'::jsonb)
        into v_open, v_closed
        from jsonb_array_elements(v_t -> 'pipeline' -> 'stages') with ordinality as e(value, n)
       where not exists (
               select 1 from public.stages s
                where s.organization_id = p_org and s.pipeline_id = v_pipeline
                  and (btrim(s.name) = btrim(e.value ->> 'name')
                       or (e.value ->> 'kind' <> 'open' and s.kind::text = e.value ->> 'kind')));

      if jsonb_array_length(v_open) > 0 then
        select min(s.position) into v_pos from public.stages s
         where s.organization_id = p_org and s.pipeline_id = v_pipeline and s.kind <> 'open';
        if v_pos is not null then
          -- one update for all of them: the won / lost stages (and anything after) move down
          update public.stages s set position = s.position + jsonb_array_length(v_open)
           where s.organization_id = p_org and s.pipeline_id = v_pipeline and s.position >= v_pos;
        else
          select coalesce(max(s.position) + 1, 0) into v_pos from public.stages s
           where s.organization_id = p_org and s.pipeline_id = v_pipeline;
        end if;
        for v_item in select e.value from jsonb_array_elements(v_open) as e loop
          insert into public.stages (organization_id, pipeline_id, name, position, kind, probability, rot_days)
          values (p_org, v_pipeline, v_item ->> 'name', v_pos, 'open',
                  (v_item ->> 'probability')::smallint, (v_item ->> 'rot_days')::integer);
          v_pos := v_pos + 1;
          v_stages := v_stages + 1;
        end loop;
      end if;

      for v_item in select e.value from jsonb_array_elements(v_closed) as e loop
        insert into public.stages (organization_id, pipeline_id, name, position, kind, probability, rot_days)
        values (p_org, v_pipeline, v_item ->> 'name',
                coalesce((select max(s.position) + 1 from public.stages s
                           where s.organization_id = p_org and s.pipeline_id = v_pipeline), 0),
                (v_item ->> 'kind')::public.stage_kind,
                (v_item ->> 'probability')::smallint, (v_item ->> 'rot_days')::integer);
        v_stages := v_stages + 1;
      end loop;
    end if;
  end if;

  -- lead statuses (open), before the first converted / not relevant one
  select coalesce(array_agg(e.value order by e.n), '{}')
    into v_names
    from jsonb_array_elements_text(v_t -> 'statuses') with ordinality as e(value, n)
   where not exists (
           select 1 from public.lead_statuses s
            where s.organization_id = p_org and btrim(s.name) = btrim(e.value));
  if cardinality(v_names) > 0 then
    select min(s.position) into v_pos from public.lead_statuses s
     where s.organization_id = p_org and s.kind <> 'open';
    if v_pos is not null then
      update public.lead_statuses s set position = s.position + cardinality(v_names)
       where s.organization_id = p_org and s.position >= v_pos;
    else
      select coalesce(max(s.position) + 1, 0) into v_pos from public.lead_statuses s where s.organization_id = p_org;
    end if;
    foreach v_name in array v_names loop
      insert into public.lead_statuses (organization_id, name, kind, position, is_default)
      values (p_org, v_name, 'open', v_pos, false);
      v_pos := v_pos + 1;
      v_statuses := v_statuses + 1;
    end loop;
  end if;

  -- lead sources
  for v_name in select e.value from jsonb_array_elements_text(v_t -> 'sources') as e loop
    continue when exists (
      select 1 from public.lead_sources s
       where s.organization_id = p_org and btrim(s.name) = btrim(v_name));
    insert into public.lead_sources (organization_id, name, kind) values (p_org, v_name, 'other');
    v_sources := v_sources + 1;
  end loop;

  -- custom fields (the plan limit per object type is the table's trigger)
  for v_item in select e.value from jsonb_array_elements(v_t -> 'fields') as e loop
    continue when exists (
      select 1 from public.field_definitions f
       where f.organization_id = p_org and f.object_type = v_item ->> 'object_type'
         and (f.key = v_item ->> 'key' or btrim(f.label) = btrim(v_item ->> 'label')));
    begin
      insert into public.field_definitions (organization_id, object_type, key, label, field_type, options, privacy_class, position, created_by)
      values (
        p_org, v_item ->> 'object_type', v_item ->> 'key', v_item ->> 'label', v_item ->> 'field_type',
        v_item -> 'options', v_item ->> 'privacy_class',
        coalesce((select max(f.position) + 1 from public.field_definitions f
                   where f.organization_id = p_org and f.object_type = v_item ->> 'object_type'), 0),
        v_uid);
      v_fields := v_fields + 1;
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_hint = pg_exception_hint;
      if coalesce(v_hint, '') not like 'limit:%' then
        raise;
      end if;
      v_limits := v_limits || v_hint;
    end;
  end loop;

  -- automations, switched off: the business turns on what it wants
  for v_item in select e.value from jsonb_array_elements(v_t -> 'automations') as e loop
    continue when exists (
      select 1 from public.automations a
       where a.organization_id = p_org
         and (a.template_key = 'industry:' || p_industry || ':' || (v_item ->> 'key')
              or btrim(a.name) = btrim(v_item ->> 'name')));
    insert into public.automations
      (organization_id, name, template_key, is_active, entity_type, trigger_type, trigger_config, conditions, actions, created_by)
    values (
      p_org, v_item ->> 'name', 'industry:' || p_industry || ':' || (v_item ->> 'key'), false,
      v_item ->> 'entity_type', v_item ->> 'trigger_type', v_item -> 'trigger_config', '[]'::jsonb,
      v_item -> 'actions', v_uid);
    v_automations := v_automations + 1;
  end loop;

  -- FLD-05 (wave 2): sample products, only with the product catalog in the plan (otherwise none, and no limit is
  -- reported); a name any product of the business has, archived ones too, is skipped; max_products is the table's
  -- quota trigger (products_quota), reported like the other limits. VRT-01: a kit's own products, its punch cards
  -- left for after the meeting types.
  v_has_products := app.org_has_feature(p_org, 'products');
  if v_has_products then
    for v_item in
      select e.value
        from jsonb_array_elements(case when v_kit is not null then v_kit -> 'products'
                                       else app.industry_template_products(p_industry) end) as e
       where e.value ->> 'kind' <> 'punch_card'
    loop
      continue when exists (
        select 1 from public.products pr
         where pr.organization_id = p_org and btrim(pr.name) = btrim(v_item ->> 'name'));
      begin
        insert into public.products (organization_id, name, kind, price_agorot, price_includes_vat, vat_kind, billing)
        values (p_org, v_item ->> 'name', v_item ->> 'kind', (v_item ->> 'price_agorot')::bigint, false, 'taxable', v_item ->> 'billing');
        v_products := v_products + 1;
      exception when sqlstate 'P0001' then
        get stacked diagnostics v_hint = pg_exception_hint;
        if coalesce(v_hint, '') not like 'limit:%' then
          raise;
        end if;
        v_limits := v_limits || v_hint;
      end;
    end loop;
  end if;

  if v_kit is not null then
    -- VRT-01: meeting types (CAL-08, every plan); the product link only to an offerable product of the kit's name
    for v_item in select e.value from jsonb_array_elements(v_kit -> 'meeting_types') as e loop
      continue when exists (
        select 1 from public.meeting_types t
         where t.organization_id = p_org and lower(btrim(t.name)) = lower(btrim(v_item ->> 'name')));
      v_id := null;
      if v_has_products and jsonb_typeof(v_item -> 'product') = 'string' then
        select pr.id into v_id from public.products pr
         where pr.organization_id = p_org and btrim(pr.name) = btrim(v_item ->> 'product')
           and pr.is_active and pr.archived_at is null
         order by pr.created_at, pr.id
         limit 1;
      end if;
      begin
        insert into public.meeting_types (organization_id, name, duration_minutes, meeting_format, product_id,
                                          buffer_before_minutes, buffer_after_minutes, color, position)
        values (p_org, v_item ->> 'name', (v_item ->> 'duration_minutes')::integer, v_item ->> 'meeting_format', v_id,
                (v_item ->> 'buffer_before_minutes')::integer, (v_item ->> 'buffer_after_minutes')::integer,
                v_item ->> 'color',
                coalesce((select max(t.position) + 1 from public.meeting_types t where t.organization_id = p_org), 0));
        v_meeting_types := v_meeting_types + 1;
      exception when sqlstate 'P0001' then
        get stacked diagnostics v_hint = pg_exception_hint;
        if coalesce(v_hint, '') <> 'meeting_types:max' then
          raise;
        end if;
        v_limits := v_limits || v_hint;
      end;
    end loop;

    -- punch card products (PKG-01): only with the products flag and the punch_cards key; none and nothing reported otherwise
    if v_has_products and app.org_has_feature(p_org, 'punch_cards') then
      for v_item in select e.value from jsonb_array_elements(v_kit -> 'products') as e where e.value ->> 'kind' = 'punch_card' loop
        continue when exists (
          select 1 from public.products pr
           where pr.organization_id = p_org and btrim(pr.name) = btrim(v_item ->> 'name'));
        v_id := null;
        if jsonb_typeof(v_item -> 'punch' -> 'meeting_type') = 'string' then
          select t.id into v_id from public.meeting_types t
           where t.organization_id = p_org and lower(btrim(t.name)) = lower(btrim(v_item -> 'punch' ->> 'meeting_type'));
        end if;
        begin
          insert into public.products (organization_id, name, kind, price_agorot, price_includes_vat, vat_kind, billing,
                                       punch_entries, punch_validity_count, punch_validity_unit, punch_meeting_type_ids)
          values (p_org, v_item ->> 'name', 'punch_card', (v_item ->> 'price_agorot')::bigint, false, 'taxable', v_item ->> 'billing',
                  (v_item -> 'punch' ->> 'entries')::integer, (v_item -> 'punch' ->> 'validity_count')::integer,
                  v_item -> 'punch' ->> 'validity_unit', case when v_id is null then null else array[v_id] end);
          v_products := v_products + 1;
        exception when sqlstate 'P0001' then
          get stacked diagnostics v_hint = pg_exception_hint;
          if coalesce(v_hint, '') not like 'limit:%' then
            raise;
          end if;
          v_limits := v_limits || v_hint;
        end;
      end loop;
    end if;

    -- message templates (MSG-02, every plan): DRAFT wording with its marker
    for v_item in select e.value from jsonb_array_elements(v_kit -> 'message_templates') as e loop
      continue when exists (
        select 1 from public.message_templates m
         where m.organization_id = p_org and lower(btrim(m.name)) = lower(btrim(v_item ->> 'name')));
      begin
        insert into public.message_templates (organization_id, name, channel, message_type, subject, body, wording_version)
        values (p_org, v_item ->> 'name', v_item ->> 'channel', v_item ->> 'message_type', v_item ->> 'subject',
                v_item ->> 'body', 'kit-draft-1');
        v_message_templates := v_message_templates + 1;
      exception when sqlstate 'P0001' then
        get stacked diagnostics v_hint = pg_exception_hint;
        if coalesce(v_hint, '') <> 'message_templates:max' then
          raise;
        end if;
        v_limits := v_limits || v_hint;
      end;
    end loop;

    -- WhatsApp templates (WA-01, every plan)
    for v_item in select e.value from jsonb_array_elements(v_kit -> 'whatsapp_templates') as e loop
      continue when exists (
        select 1 from public.whatsapp_templates w
         where w.organization_id = p_org and lower(btrim(w.name)) = lower(btrim(v_item ->> 'name')));
      begin
        insert into public.whatsapp_templates (organization_id, name, body, position)
        values (p_org, v_item ->> 'name', v_item ->> 'body',
                coalesce((select max(w.position) + 1 from public.whatsapp_templates w where w.organization_id = p_org), 0));
        v_whatsapp_templates := v_whatsapp_templates + 1;
      exception when sqlstate 'P0001' then
        get stacked diagnostics v_hint = pg_exception_hint;
        if coalesce(v_hint, '') <> 'whatsapp_templates:max' then
          raise;
        end if;
        v_limits := v_limits || v_hint;
      end;
    end loop;

    -- one web form, switched off; a custom field the business lacks, has inactive, or of a type public forms never show
    -- (FORM_EXCLUDED_TYPES in src/features/intake/fields.ts) is left out
    if not exists (select 1 from public.forms f
                    where f.organization_id = p_org and btrim(f.name) = btrim(v_kit -> 'form' ->> 'name')) then
      select coalesce(jsonb_agg(jsonb_build_object('key', e.value ->> 'key', 'required', (e.value ->> 'required')::boolean)
                                order by e.n), '[]'::jsonb)
        into v_fields_json
        from jsonb_array_elements(v_kit -> 'form' -> 'fields') with ordinality as e(value, n)
       where e.value ->> 'key' not like 'cf:%'
          or exists (select 1 from public.field_definitions fd
                      where fd.organization_id = p_org and fd.object_type = 'lead' and fd.is_active
                        and fd.field_type not in ('user', 'rich_text', 'duration', 'status', 'record_link', 'file')
                        and 'cf:' || fd.key = e.value ->> 'key');
      begin
        insert into public.forms (organization_id, kind, name, title, intro, submit_label, success_message, fields,
                                  owner_id, is_active, created_by)
        values (p_org, 'form', v_kit -> 'form' ->> 'name', v_kit -> 'form' ->> 'title', v_kit -> 'form' ->> 'intro',
                v_kit -> 'form' ->> 'submit_label', v_kit -> 'form' ->> 'success_message', v_fields_json,
                v_uid, false, v_uid);
        v_forms := 1;
      exception when sqlstate 'P0001' then
        get stacked diagnostics v_hint = pg_exception_hint;
        if coalesce(v_hint, '') not like 'limit:%' then
          raise;
        end if;
        v_limits := v_limits || v_hint;
      end;
    end if;

    -- organization-wide lead views by the kit's status (LST-04's shape: {filters, sort, columns})
    for v_item in select e.value from jsonb_array_elements(v_kit -> 'views') as e loop
      continue when exists (
        select 1 from public.saved_views v
         where v.organization_id = p_org and v.object_type = v_item ->> 'object_type' and v.scope = 'org'
           and btrim(v.name) = btrim(v_item ->> 'name'));
      select s.id into v_id from public.lead_statuses s
       where s.organization_id = p_org and btrim(s.name) = btrim(v_item ->> 'status')
       order by s.position, s.created_at
       limit 1;
      continue when v_id is null;
      insert into public.saved_views (organization_id, object_type, name, config, scope, owner_id)
      values (p_org, v_item ->> 'object_type', v_item ->> 'name',
              jsonb_build_object('filters', jsonb_build_object('status', v_id::text), 'sort', null, 'columns', null),
              'org', v_uid);
      v_views := v_views + 1;
    end loop;
  end if;

  -- recorded only when complete: a template that a limit cut short is still offered
  if cardinality(v_limits) = 0 then
    update public.organizations o
       set industry_templates = o.industry_templates || p_industry
     where o.id = p_org and not (p_industry = any (o.industry_templates));
  end if;

  return jsonb_build_object(
    'added', jsonb_build_object(
      'pipelines', v_pipelines, 'stages', v_stages, 'statuses', v_statuses,
      'sources', v_sources, 'fields', v_fields, 'automations', v_automations, 'products', v_products,
      'meeting_types', v_meeting_types, 'message_templates', v_message_templates,
      'whatsapp_templates', v_whatsapp_templates, 'forms', v_forms, 'views', v_views),
    'limits', (select coalesce(jsonb_agg(distinct l), '[]'::jsonb) from unnest(v_limits) as l));
end;
$$;
revoke all on function public.apply_industry_template(uuid, text) from public, anon;
grant execute on function public.apply_industry_template(uuid, text) to authenticated;

-- =============================================================================
-- Industry templates (FLD-05)
-- =============================================================================
-- A template is a package the business adds on top of what it has: a sales
-- pipeline with stages, lead statuses, lead sources, custom fields and
-- automations. It is applied in the setup wizard (step 2) or later from the
-- business details page, by owners and admins of a writable organization.
--
-- * app.industry_template(key): the templates as data, one per industry key of
--   the sign-up form. It mirrors src/features/industry-templates/templates.ts;
--   tests/db/65-industry-templates.test.ts keeps the two equal.
-- * public.apply_industry_template(org, industry): adds what is missing and
--   never deletes or renames anything. A name that exists is skipped, so
--   applying twice adds nothing the second time. Names are compared with
--   btrim() on both sides (outer spaces only, no case folding), the rule of
--   previewTemplate() in the TS module:
--     pipeline    added when no pipeline outside the recycle bin has its name
--                 (several: the first by position, created_at);
--                 otherwise its missing stages go into the existing one (a won
--                 or lost stage only when that pipeline has none of that kind)
--     stages      open ones are put before the first won/lost stage (the stages
--                 from there move down by the number added, in one update;
--                 their order is kept)
--     statuses    open, put before the first converted / not relevant status
--                 (same way)
--     sources     kind 'other'
--     fields      skipped when the object already has the key or the label
--     automations added switched off (is_active = false), with template_key
--                 'industry:<industry>:<key>'; skipped when that key or the name exists
--   Plan limits are the tables' own triggers (max_pipelines,
--   max_custom_fields_per_object). An item that hits a limit is skipped and the
--   limit is reported in the answer; the rest is still added. Any other error
--   aborts the whole apply.
--   The applied industry is recorded in organizations.industry_templates (server
--   only; the organization's audit trigger logs the change with the actor), but
--   only when no limit left anything out, so the screens keep offering it.
--   Returns {"added": {pipelines, stages, statuses, sources, fields, automations},
--            "limits": ["limit:<key>", ...]}.
-- * create_organization() is not changed: new organizations keep today's defaults.
-- Every statement is safe to run twice.

alter table public.organizations
  add column if not exists industry_templates text[] not null default '{}';

comment on column public.organizations.industry_templates is
  'FLD-05: industry templates applied to this organization (keys of app.industry_template), written only by apply_industry_template().';

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
        {"object_type":"contact","key":"health_fund","label":"קופת חולים","field_type":"select","options":["כללית","מכבי","מאוחדת","לאומית"]},
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

create or replace function public.apply_industry_template(p_org uuid, p_industry text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
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
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not app.is_admin(p_org) or not app.org_writable(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  v_t := app.industry_template(p_industry);
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
      insert into public.field_definitions (organization_id, object_type, key, label, field_type, options, position, created_by)
      values (
        p_org, v_item ->> 'object_type', v_item ->> 'key', v_item ->> 'label', v_item ->> 'field_type',
        v_item -> 'options',
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

  -- recorded only when complete: a template that a limit cut short is still offered
  if cardinality(v_limits) = 0 then
    update public.organizations o
       set industry_templates = o.industry_templates || p_industry
     where o.id = p_org and not (p_industry = any (o.industry_templates));
  end if;

  return jsonb_build_object(
    'added', jsonb_build_object(
      'pipelines', v_pipelines, 'stages', v_stages, 'statuses', v_statuses,
      'sources', v_sources, 'fields', v_fields, 'automations', v_automations),
    'limits', (select coalesce(jsonb_agg(distinct l), '[]'::jsonb) from unnest(v_limits) as l));
end;
$$;
revoke all on function public.apply_industry_template(uuid, text) from public, anon;
grant execute on function public.apply_industry_template(uuid, text) to authenticated;

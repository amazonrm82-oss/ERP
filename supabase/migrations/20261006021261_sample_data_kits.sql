-- VRT-03: sample data by industry (extends USR-04), part 1 of 2: the content, which kit a business gets, the sample punch
-- card's note and app.sample_untouched(). Part 2 (sample_data_kits_add) adds the records. Split so each file fits one apply
-- call; the parts run in name order.
-- * app.sample_kit_content(kit): the sample set of the kits 'clinic' and 'studio' as data (null for any other key):
--   {leads, contacts, deal, tasks, punch_card}. It mirrors SAMPLE_KIT_CONTENT in src/features/setup/sample-kits.ts;
--   tests/db/358-sample-data-kits keeps the two equal. DRAFT wording. The clinics set holds no health or medical content
--   (tests check the closed list of medical words). Invented names, @example.com addresses, no phones.
-- * app.sample_kit(org): the kit a business's sample data follows: the last kit key in organizations.industry_templates
--   (VRT-01 records it when a kit was applied in full), else the kit of the sign-up industry (health = clinic,
--   education = studio, the rule of suggestedTemplateKey), else null = the generic USR-04 set, unchanged. Mirrored by
--   sampleDataKit().
-- * app.sample_kit_fields(org, object, values): the custom field values of a sample record that fit the business now: an
--   active field of that record type and key, not unique, not a person/record link/file, and a value app.custom_value_ok
--   accepts. Anything else is left out (a business that renamed or removed the kit's field gets the record without it).
-- * app.sample_punch_cards (schema app, RLS on, no grants): the note of the one punch card a studio or clinic set may open
--   (only with the plan key punch_cards and the kit's punch card product in the catalog), with a snapshot of the card row
--   (without updated_at). Composite FK to the card ON DELETE CASCADE: the card goes with its sample contact (punch_cards'
--   own contact cascade), and its note with it, so sample_data_remove (unchanged) needs no new delete.
--   app.sample_punch_card_pristine(org, card): the card is noted, its row equals the snapshot, and it has no use.
-- * app.sample_untouched(): 021260's body with one change: a punch card on a sample contact keeps the contact only when it is
--   not the sample data's own unchanged, unused card (a card a person opened, or the sample card once used, cancelled or
--   transferred, is real work as before).
-- Every statement is safe to run twice. No drop statement, no row removal.

create or replace function app.sample_kit_content(p_kit text) returns jsonb
language sql immutable
set search_path = ''
as $fn$
  select case p_kit
    when 'clinic' then $c${"leads":[{"key":"l1","full_name":"רונית כהן","email":"ronit@example.com","status":"ממתין לתור","source":"גוגל","message":"רוצה לקבוע פגישת היכרות. פנייה לדוגמה. אפשר למחוק את כל נתוני הדוגמה בלחיצה מרשימת ההקמה.","custom_fields":{"treatment_type":"פגישת היכרות","referral_source":"אינטרנט"}},{"key":"l2","full_name":"אלון מזרחי","email":"alon@example.com","status":"ביקש שיחה חוזרת","source":"הפניה מגורם מקצועי","message":"מבקש לשמוע על סדרת טיפולים ועל שעות הקבלה. פנייה לדוגמה.","custom_fields":{"treatment_type":"סדרת טיפולים","referral_source":"איש או אשת מקצוע"}},{"key":"l3","full_name":"שירה גולן","email":"shira@example.com","status":"נקבע תור","source":"אינסטגרם","message":null,"custom_fields":{"treatment_type":"טיפול בודד","preferred_therapist":"דנה"}}],"contacts":[{"key":"c1","first_name":"יעל","last_name":"ברגר","email":"yael@example.com","city":"רמת גן","custom_fields":{"preferred_time":"בוקר"}},{"key":"c2","first_name":"משה","last_name":"פרידמן","email":"moshe@example.com","city":"ירושלים","custom_fields":{"preferred_time":"ערב"}}],"deal":{"name":"סדרת 10 טיפולים","amount_agorot":270000,"pipeline":"טיפולים בקליניקה","stage":"בסדרת טיפולים","contact":"c1","custom_fields":{"sessions_count":10}},"tasks":[{"title":"להתקשר לרונית כהן לתיאום פגישת היכרות","task_type":"call","due_minutes":120,"lead":"l1","deal":false},{"title":"לתאם עם יעל ברגר את התור הבא בסדרה","task_type":"todo","due_minutes":1440,"lead":null,"deal":true}],"punch_card":{"contact":"c1","product":"כרטיסייה ל-10 טיפולים"}}$c$::jsonb
    when 'studio' then $c${"leads":[{"key":"l1","full_name":"נועם אלמוג","email":"noam@example.com","status":"נקבע שיעור ניסיון","source":"אינסטגרם","message":"רוצה לנסות שיעור ניסיון בקבוצת מתחילים. פנייה לדוגמה. אפשר למחוק את כל נתוני הדוגמה בלחיצה מרשימת ההקמה.","custom_fields":{"level":"מתחילים","track":"כרטיסייה","preferred_days":["ראשון","רביעי"]}},{"key":"l2","full_name":"הילה שגב","email":"hila@example.com","status":"ממתין לפתיחת קבוצה","source":"חבר מביא חבר","message":"שואלת מתי נפתחת קבוצת ערב. פנייה לדוגמה.","custom_fields":{"level":"ממשיכים","track":"שיעורים קבועים"}},{"key":"l3","full_name":"תומר וייס","email":"tomer@example.com","status":"הגיע לשיעור ניסיון","source":"פייסבוק","message":null,"custom_fields":{"track":"קורס"}}],"contacts":[{"key":"c1","first_name":"מאיה","last_name":"ברק","email":"maya@example.com","city":"חיפה","custom_fields":{}},{"key":"c2","first_name":"עידו","last_name":"שמש","email":"ido@example.com","city":"כפר סבא","custom_fields":{"parent_name":"רינת שמש"}}],"deal":{"name":"קורס מתחילים","amount_agorot":120000,"pipeline":"הרשמה לסטודיו","stage":"ממתין לתשלום","contact":"c2","custom_fields":{}},"tasks":[{"title":"לתאם שיעור ניסיון עם נועם אלמוג","task_type":"call","due_minutes":120,"lead":"l1","deal":false},{"title":"לשלוח לעידו שמש את פרטי הפתיחה של הקורס","task_type":"todo","due_minutes":1440,"lead":null,"deal":true}],"punch_card":{"contact":"c1","product":"כרטיסייה ל-10 שיעורים"}}$c$::jsonb
  end
$fn$;
revoke all on function app.sample_kit_content(text) from public, anon, authenticated;

create or replace function app.sample_kit(p_org uuid) returns text
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
    (select t.k
       from public.organizations o
      cross join lateral unnest(o.industry_templates) with ordinality as t(k, n)
      where o.id = p_org and t.k in ('clinic', 'studio')
      order by t.n desc
      limit 1),
    (select case o.industry when 'health' then 'clinic' when 'education' then 'studio' end
       from public.organizations o
      where o.id = p_org))
$$;
revoke all on function app.sample_kit(uuid) from public, anon, authenticated;

create or replace function app.sample_kit_fields(p_org uuid, p_object text, p_values jsonb) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(v.key, v.value), '{}'::jsonb)
    from jsonb_each(case when jsonb_typeof(p_values) = 'object' then p_values else '{}'::jsonb end) v
    join public.field_definitions f
      on f.organization_id = p_org and f.object_type = p_object and f.key = v.key
   where f.is_active
     and not f.is_unique
     and f.field_type not in ('user', 'record_link', 'file')
     and app.custom_value_ok(f.field_type, f.options, v.value)
$$;
revoke all on function app.sample_kit_fields(uuid, text, jsonb) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The sample punch card's note
-- ----------------------------------------------------------------------------
create table if not exists app.sample_punch_cards (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  punch_card_id   uuid not null,
  -- the card as opened, without updated_at
  snapshot        jsonb not null,
  created_at      timestamptz not null default now(),
  constraint sample_punch_cards_card_fk foreign key (organization_id, punch_card_id)
    references public.punch_cards (organization_id, id) on delete cascade
);
create unique index if not exists sample_punch_cards_card_idx on app.sample_punch_cards (organization_id, punch_card_id);

alter table app.sample_punch_cards enable row level security;
revoke all on app.sample_punch_cards from public, anon, authenticated;

-- a card as compared with its snapshot; null when the card is gone
create or replace function app.sample_punch_card_row(p_org uuid, p_card uuid) returns jsonb
language sql stable security definer
set search_path = ''
-- timestamps in the snapshot must not depend on the caller's time zone
set timezone = 'UTC'
as $$
  select to_jsonb(c) - 'updated_at' from public.punch_cards c where c.organization_id = p_org and c.id = p_card
$$;
revoke all on function app.sample_punch_card_row(uuid, uuid) from public, anon, authenticated;

create or replace function app.sample_punch_card_pristine(p_org uuid, p_card uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.sample_punch_cards s
     where s.organization_id = p_org and s.punch_card_id = p_card
       and app.sample_punch_card_row(p_org, p_card) is not distinct from s.snapshot)
     and not exists (select 1 from public.punch_card_uses u where u.organization_id = p_org and u.card_id = p_card)
$$;
revoke all on function app.sample_punch_card_pristine(uuid, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- app.sample_untouched: 021260's body, the sample card exempted (above)
-- ----------------------------------------------------------------------------
create or replace function app.sample_untouched(p_org uuid, p_type text, p_id uuid, p_snapshot jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_col text := p_type || '_id';
  v_found boolean;
begin
  if app.sample_row(p_org, p_type, p_id) is distinct from p_snapshot then
    return false;
  end if;
  if p_type = 'task' then
    -- TASK-06: a sample task a person gave steps to is real work
    return not exists (select 1 from public.task_checklist_items i where i.organization_id = p_org and i.task_id = p_id)
       -- TASK-06 part B: a sub-task a person added under it (sample data makes none)
       and not exists (select 1 from public.tasks c where c.organization_id = p_org and c.parent_task_id = p_id);
  end if;
  -- notes, files and meetings are never sample data; nor a library link (LIB-02)
  execute format(
    'select exists (select 1 from public.activities where organization_id = $1 and %1$I = $2)
         or exists (select 1 from public.files where organization_id = $1 and %1$I = $2)
         or exists (select 1 from public.meetings where organization_id = $1 and %1$I = $2)
         or exists (select 1 from public.library_links where organization_id = $1 and %1$I = $2)', v_col)
    into v_found using p_org, p_id;
  if v_found then
    return false;
  end if;
  -- a task that is not an unchanged sample task, or one a person gave steps to (TASK-06; removing the record would
  -- take such a task with it)
  execute format(
    'select exists (select 1 from public.tasks t where t.organization_id = $1 and t.%1$I = $2
                     and (not app.sample_pristine($1, ''task'', t.id)
                          or exists (select 1 from public.task_checklist_items i
                                      where i.organization_id = t.organization_id and i.task_id = t.id)))', v_col)
    into v_found using p_org, p_id;
  if v_found then
    return false;
  end if;
  if p_type = 'lead' then
    return not exists (select 1 from public.form_submissions f where f.organization_id = p_org and f.lead_id = p_id)
       -- CNS-01: sample data records no consent; one recorded is real work
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.lead_id = p_id)
       -- CON-06: a referral by the lead
       and not exists (select 1 from public.contact_relations cr where cr.organization_id = p_org and cr.lead_id = p_id)
       -- SEG-01: put in a list by a person
       and not exists (select 1 from public.segment_members sm where sm.organization_id = p_org and sm.lead_id = p_id)
       -- MSG-03: sample data sends no messages; one sent or received is real
       and not exists (select 1 from public.messages ms where ms.organization_id = p_org and ms.lead_id = p_id);
  elsif p_type = 'contact' then
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.contact_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_contact_id = p_id)
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.contact_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id))
       -- CON-01: sample data adds no further phones or emails; one added is real work
       and not exists (select 1 from public.contact_channels ch where ch.organization_id = p_org and ch.contact_id = p_id)
       -- CNS-01: a consent recorded on it
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.contact_id = p_id)
       -- CON-05: a further company, or a role at the primary one
       and not exists (select 1 from public.contact_companies cc where cc.organization_id = p_org and cc.contact_id = p_id
                         and (not cc.is_primary or cc.title is not null))
       -- CON-06: sample data makes no relations; one made is real work
       and not exists (select 1 from public.contact_relations cr where cr.organization_id = p_org and p_id in (cr.contact_id, cr.related_contact_id))
       -- QUO-01: sample data makes no quotes; one made is real work
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.contact_id = p_id)
       -- ORD-01: sample data makes no orders; one made is real work
       and not exists (select 1 from public.orders od where od.organization_id = p_org and p_id in (od.contact_id, od.delivery_contact_id))
       -- DOC-01: sample data records no documents; one recorded is real work
       and not exists (select 1 from public.accounting_documents ad where ad.organization_id = p_org and ad.contact_id = p_id)
       -- PAY-01: sample data records no payments; one recorded is real work
       and not exists (select 1 from public.payments pm where pm.organization_id = p_org and pm.contact_id = p_id)
       -- COL-05: sample data holds nobody; a hold set is real work
       and not exists (select 1 from public.customer_holds ch where ch.organization_id = p_org and ch.contact_id = p_id)
       -- RVW-64 (COL-03): sample data makes no payment promises; one recorded on the customer is real work
       and not exists (select 1 from public.payment_promises pp where pp.organization_id = p_org and pp.contact_id = p_id)
       -- SEG-01: put in a list by a person
       and not exists (select 1 from public.segment_members sm where sm.organization_id = p_org and sm.contact_id = p_id)
       -- MSG-03
       and not exists (select 1 from public.messages ms where ms.organization_id = p_org and ms.contact_id = p_id)
       -- PKG-01: a punch card opened by a person is real work (the card would go with the contact); VRT-03: the sample
       -- data's own card counts as sample while it is unchanged and unused (app.sample_punch_card_pristine)
       and not exists (select 1 from public.punch_cards pc where pc.organization_id = p_org and pc.contact_id = p_id
                         and not app.sample_punch_card_pristine(p_org, pc.id))
       -- PKG-06: named as the service recipient of a line, or the payer of a card
       and not exists (select 1 from public.quote_lines ql where ql.organization_id = p_org and ql.recipient_contact_id = p_id)
       and not exists (select 1 from public.order_lines ol where ol.organization_id = p_org and ol.recipient_contact_id = p_id)
       and not exists (select 1 from public.punch_cards pc where pc.organization_id = p_org and pc.payer_contact_id = p_id)
       -- SUB-01: sample data makes no recurring billing; one made is real work (it would go with the contact)
       and not exists (select 1 from public.recurring_billings rb where rb.organization_id = p_org and rb.contact_id = p_id);
  elsif p_type = 'company' then
    return not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_company_id = p_id)
       and not exists (select 1 from public.companies c where c.organization_id = p_org and c.parent_company_id = p_id)
       and not exists (select 1 from public.contacts c where c.organization_id = p_org and c.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'contact', c.id))
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id))
       -- CON-05: someone linked to it as a further company, or given a role there
       and not exists (select 1 from public.contact_companies cc where cc.organization_id = p_org and cc.company_id = p_id
                         and (not cc.is_primary or cc.title is not null))
       -- QUO-01
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.company_id = p_id)
       -- ORD-01
       and not exists (select 1 from public.orders od where od.organization_id = p_org and od.company_id = p_id)
       -- COL-05
       and not exists (select 1 from public.customer_holds ch where ch.organization_id = p_org and ch.company_id = p_id)
       -- RVW-64 (COL-03): a payment promise on the company, or on one of its own documents (an opening balance)
       and not exists (select 1 from public.payment_promises pp where pp.organization_id = p_org and pp.company_id = p_id)
       and not exists (select 1 from public.payment_promises pp
                         join public.accounting_documents ad on ad.organization_id = pp.organization_id and ad.id = pp.document_id
                        where pp.organization_id = p_org and ad.company_id = p_id)
       -- PKG-06: the company paid for a card someone else holds
       and not exists (select 1 from public.punch_cards pc where pc.organization_id = p_org and pc.payer_company_id = p_id)
       -- SUB-01: a recurring billing of the company
       and not exists (select 1 from public.recurring_billings rb where rb.organization_id = p_org and rb.company_id = p_id);
  else -- deal
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.deal_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_deal_id = p_id)
       -- DLI-01: sample data adds no product lines; one added is real work
       and not exists (select 1 from public.deal_lines dl where dl.organization_id = p_org and dl.deal_id = p_id)
       -- QUO-01
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.deal_id = p_id)
       -- ORD-01
       and not exists (select 1 from public.orders od where od.organization_id = p_org and od.deal_id = p_id)
       -- DOC-01
       and not exists (select 1 from public.accounting_documents ad where ad.organization_id = p_org and ad.deal_id = p_id)
       -- PAY-01
       and not exists (select 1 from public.payments pm where pm.organization_id = p_org and pm.deal_id = p_id)
       -- SUB-03: a recurring billing made from the deal
       and not exists (select 1 from public.recurring_billings rb where rb.organization_id = p_org and rb.deal_id = p_id);
  end if;
end;
$$;
revoke all on function app.sample_untouched(uuid, text, uuid, jsonb) from public, anon, authenticated;

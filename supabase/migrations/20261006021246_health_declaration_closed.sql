-- LEGAL-2 (7), owner 12 November 2026 (and answer (202) ב): the health declaration is not released until PRV-05 (medical
-- information is sensitive). No template of that kind is seeded (app.seed_document_templates); now a person can neither
-- create one nor turn an existing template into one. A template that already has the kind stays readable and editable
-- (its text, its name, its switch), and may move to another kind. Server writes (migrations, the seed) are not judged.
--
--   app.document_templates_health_closed()  invoker (it tells a person's write by current_user), BEFORE INSERT OR UPDATE OF
--       kind; P0001 hint 'document_template:health_closed'
--
-- Every statement is safe to run twice.

create or replace function app.document_templates_health_closed() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated'
     and new.kind = 'health_declaration'
     and (tg_op = 'INSERT' or old.kind is distinct from new.kind) then
    raise exception 'health declaration templates are not available yet'
      using errcode = 'P0001', hint = 'document_template:health_closed';
  end if;
  return new;
end;
$$;
revoke all on function app.document_templates_health_closed() from public, anon, authenticated;

create or replace trigger document_templates_health_closed
  before insert or update of kind on public.document_templates
  for each row execute function app.document_templates_health_closed();

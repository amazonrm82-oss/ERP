drop policy automations_update on public.automations;
create policy automations_update on public.automations for UPDATE to authenticated using (true) with check (true);

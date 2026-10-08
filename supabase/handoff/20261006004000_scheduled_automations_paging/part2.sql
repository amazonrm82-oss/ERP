-- 20261006004000_scheduled_automations_paging: part 2 of 2. Run the parts in order.
revoke all on function app.run_scheduled_automations() from public, anon, authenticated;
grant execute on function app.run_scheduled_automations() to service_role;

-- 20261006001300_platform: part 11 of 11. Run the parts in order.
grant execute on function public.platform_set_overrides(uuid, jsonb, jsonb, text) to authenticated;
grant execute on function public.platform_set_org_status(uuid, public.org_status, text) to authenticated;
grant execute on function public.platform_update_plan(text, text, integer, integer, jsonb, jsonb, boolean) to authenticated;
grant execute on function public.platform_metrics() to authenticated;
grant execute on function public.platform_staff_list() to authenticated;
grant execute on function public.platform_set_staff(text, text) to authenticated;
grant execute on function public.platform_log_list(uuid, integer) to authenticated;
grant execute on function public.platform_open_support(uuid) to authenticated;

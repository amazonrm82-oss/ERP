-- 20261006001100_reports: part 10 of 10. Run the parts in order.
revoke all on function public.report_leads_by_source(uuid, timestamptz, timestamptz, uuid) from public, anon;
revoke all on function public.report_funnel(uuid, timestamptz, timestamptz, uuid, uuid) from public, anon;
revoke all on function public.report_response_time(uuid, timestamptz, timestamptz, uuid) from public, anon;
revoke all on function public.report_rep_performance(uuid, timestamptz, timestamptz, uuid) from public, anon;
revoke all on function public.report_activity(uuid, timestamptz, timestamptz, uuid) from public, anon;
revoke all on function public.report_forecast(uuid, uuid, uuid) from public, anon;
revoke all on function public.report_lost_reasons(uuid, timestamptz, timestamptz, uuid, uuid) from public, anon;
revoke all on function public.report_cycle_length(uuid, timestamptz, timestamptz, uuid, uuid) from public, anon;
revoke all on function public.report_stuck_deals(uuid, uuid, uuid, integer) from public, anon;
revoke all on function public.report_revenue(uuid, timestamptz, timestamptz, uuid, uuid) from public, anon;
revoke all on function public.report_summary(uuid, timestamptz, timestamptz, timestamptz, timestamptz, uuid) from public, anon;

grant execute on function public.report_leads_by_source(uuid, timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public.report_funnel(uuid, timestamptz, timestamptz, uuid, uuid) to authenticated;
grant execute on function public.report_response_time(uuid, timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public.report_rep_performance(uuid, timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public.report_activity(uuid, timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public.report_forecast(uuid, uuid, uuid) to authenticated;
grant execute on function public.report_lost_reasons(uuid, timestamptz, timestamptz, uuid, uuid) to authenticated;
grant execute on function public.report_cycle_length(uuid, timestamptz, timestamptz, uuid, uuid) to authenticated;
grant execute on function public.report_stuck_deals(uuid, uuid, uuid, integer) to authenticated;
grant execute on function public.report_revenue(uuid, timestamptz, timestamptz, uuid, uuid) to authenticated;
grant execute on function public.report_summary(uuid, timestamptz, timestamptz, timestamptz, timestamptz, uuid) to authenticated;

-- 20261006002000_merge_records: part 4 of 4. Run the parts in order.
revoke all on function app.merge_columns(text) from public, anon;
grant execute on function app.merge_columns(text) to authenticated;
revoke all on function app.merge_move_links(uuid, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.merge_records(uuid, text, uuid, uuid, jsonb) from public, anon;
grant execute on function public.merge_records(uuid, text, uuid, uuid, jsonb) to authenticated;

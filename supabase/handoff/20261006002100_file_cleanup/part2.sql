-- 20261006002100_file_cleanup: part 2 of 2. Run the parts in order.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-file-cleanup', '0 3 * * *', 'select app.cleanup_files();');
  end if;
end;
$$;

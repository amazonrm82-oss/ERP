-- 20261006001900_record_files: part 3 of 3. Run the parts in order.
create policy record_files_select on storage.objects for select to authenticated
  using (bucket_id = 'record-files' and exists (select 1 from public.files f where f.storage_path = objects.name));
drop policy if exists record_files_insert on storage.objects;
create policy record_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'record-files'
              and exists (select 1 from public.files f where f.storage_path = objects.name and f.uploaded_by = (select auth.uid())));
drop policy if exists record_files_delete on storage.objects;
create policy record_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'record-files'
         and exists (select 1 from public.files f
                      where f.storage_path = objects.name and app.can_write(f.organization_id)
                        and (f.uploaded_by = (select auth.uid()) or app.is_admin(f.organization_id))));

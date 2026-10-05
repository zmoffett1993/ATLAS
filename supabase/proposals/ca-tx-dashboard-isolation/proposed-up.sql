-- REVIEW ONLY. Do not apply without separate backend approval.
-- Uses the existing trusted, active-account membership helper. Public anon lookup is unchanged.
begin;
create policy atlas_profile_read_warehouse_boundary on public.profiles
  as restrictive for select to authenticated
  using (user_id = (select auth.uid()) or public.atlas_user_can_access_warehouse(warehouse_id));
create policy atlas_location_read_warehouse_boundary on public.locations
  as restrictive for select to authenticated
  using (public.atlas_user_can_access_warehouse(warehouse_id));
create policy atlas_undo_read_warehouse_boundary on public.atlas_undo_snapshots
  as restrictive for select to authenticated
  using (public.atlas_user_can_access_warehouse(warehouse_id));
revoke truncate, references, trigger on table
  public.coc_model_case_quantities, public.coc_delivery_events, public.coc_stations,
  public.sku_delete_requests, public.atlas_undo_snapshots, public.coc_deliveries
  from anon, authenticated;
commit;

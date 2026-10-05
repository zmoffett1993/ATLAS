-- REVIEW ONLY. Restore only the exact grants captured before deployment.
begin;
drop policy if exists atlas_profile_read_warehouse_boundary on public.profiles;
drop policy if exists atlas_location_read_warehouse_boundary on public.locations;
drop policy if exists atlas_undo_read_warehouse_boundary on public.atlas_undo_snapshots;
grant truncate, references, trigger on table
  public.coc_model_case_quantities, public.coc_delivery_events, public.coc_stations,
  public.sku_delete_requests, public.atlas_undo_snapshots, public.coc_deliveries
  to anon, authenticated;
commit;

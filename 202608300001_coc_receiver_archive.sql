begin;

alter table public.coc_deliveries
  add column if not exists receiver_archived_at timestamptz,
  add column if not exists receiver_archived_by_user_id uuid references auth.users(id),
  add column if not exists receiver_customer_name text generated always as (lower(coalesce(report_snapshot->>'customerName',''))) stored,
  add column if not exists receiver_invoice_number text generated always as (lower(coalesce(report_snapshot->>'invoiceNumber',''))) stored,
  add column if not exists receiver_if_number text generated always as (lower(coalesce(report_snapshot->>'ifNumber',''))) stored,
  add column if not exists receiver_search_text text generated always as (
    lower(
      coalesce(report_snapshot->>'customerName','') || ' ' ||
      coalesce(report_snapshot->>'invoiceNumber','') || ' ' ||
      coalesce(report_snapshot->>'ifNumber','')
    )
  ) stored;

create index if not exists coc_deliveries_receiver_archive_idx
  on public.coc_deliveries(station_id,receiver_archived_at,office_completed_at desc);
create index if not exists coc_deliveries_receiver_customer_idx
  on public.coc_deliveries(station_id,receiver_customer_name);
create index if not exists coc_deliveries_receiver_invoice_idx
  on public.coc_deliveries(station_id,receiver_invoice_number);
create index if not exists coc_deliveries_receiver_if_idx
  on public.coc_deliveries(station_id,receiver_if_number);

alter table public.coc_delivery_events
  drop constraint if exists coc_delivery_events_event_type_check;
alter table public.coc_delivery_events
  add constraint coc_delivery_events_event_type_check check (event_type in (
    'COC_COMPLETED',
    'COC_SENT',
    'COC_RECEIVED',
    'COC_OFFICE_COMPLETED',
    'COC_RECEIVER_ARCHIVED',
    'COC_RECEIVER_RESTORED'
  ));
alter table public.coc_delivery_events
  drop constraint if exists coc_delivery_events_delivery_id_event_type_key;
create index if not exists coc_delivery_events_delivery_type_idx
  on public.coc_delivery_events(delivery_id,event_type,event_at desc);

commit;

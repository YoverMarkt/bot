-- Deduplicación persistente y multiempresa para Meta, YCloud y Kapso.
-- Solo almacena SHA-256 del identificador del proveedor; no guarda payload,
-- mensajes, teléfonos ni credenciales. Es idempotente y no modifica datos vivos.

create table if not exists public.webhook_inbound_events (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  provider        text not null check (provider in ('meta', 'ycloud', 'kapso')),
  message_id_hash text not null check (message_id_hash ~ '^[0-9a-f]{64}$'),
  received_at     timestamptz not null default now()
);

create unique index if not exists uq_webhook_events_business_provider_hash
  on public.webhook_inbound_events(business_id, provider, message_id_hash);
create index if not exists idx_webhook_events_business_received
  on public.webhook_inbound_events(business_id, received_at);
create index if not exists idx_webhook_events_received
  on public.webhook_inbound_events(received_at);

alter table public.webhook_inbound_events enable row level security;

create or replace function public.claim_webhook_event(
  p_business_id uuid,
  p_provider text,
  p_message_id_hash text
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_inserted integer;
begin
  if p_business_id is null then
    raise exception using errcode = '22023', message = 'El negocio es obligatorio';
  end if;
  if p_provider not in ('meta', 'ycloud', 'kapso') then
    raise exception using errcode = '22023', message = 'Proveedor de webhook inválido';
  end if;
  if p_message_id_hash is null or p_message_id_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Hash de mensaje inválido';
  end if;

  -- Retención acotada: suficiente para reintentos, reinicios y despliegues.
  delete from public.webhook_inbound_events
  where business_id = p_business_id
    and received_at < now() - interval '24 hours';

  insert into public.webhook_inbound_events (
    business_id,
    provider,
    message_id_hash
  ) values (
    p_business_id,
    p_provider,
    p_message_id_hash
  )
  on conflict (business_id, provider, message_id_hash) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end;
$$;

revoke all on function public.claim_webhook_event(uuid, text, text) from public;
revoke all on function public.claim_webhook_event(uuid, text, text) from anon;
revoke all on function public.claim_webhook_event(uuid, text, text) from authenticated;
grant execute on function public.claim_webhook_event(uuid, text, text) to service_role;

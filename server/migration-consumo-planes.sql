-- ============================================================
-- MIGRACIÓN: consumo mensual y límites por negocio
-- Fecha: 2026-07-26
--
-- Ejecutar en Supabase → SQL Editor ANTES de desplegar el runtime.
-- Es aditiva e idempotente: no elimina conversaciones ni facturación.
--
-- La primera versión mide:
--   • contactos únicos que escribieron;
--   • mensajes físicos entrantes;
--   • textos, imágenes, videos e interactivos salientes aceptados
--     por la API de Meta/YCloud.
--
-- "Aceptado" todavía no significa "entregado/cobrado": eso requerirá
-- conciliar los webhooks de estado de cada proveedor.
-- ============================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

create extension if not exists pgcrypto;

-- Marcadores internos para que las inicializaciones de una sola vez sigan
-- siendo seguras aunque este archivo se ejecute de nuevo meses después.
create table if not exists public.message_usage_migration_state (
  key          text primary key,
  completed_at timestamptz not null default now()
);

-- Compatibilidad con la primera versión ya ejecutada: si ambas columnas
-- existen, sus valores actuales (incluido NULL = sin límite) son intencionales.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'businesses'
      and column_name = 'monthly_contact_limit'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'businesses'
      and column_name = 'monthly_outbound_message_limit'
  ) then
    insert into public.message_usage_migration_state (key)
    values ('limits_v1')
    on conflict (key) do nothing;
  end if;
end;
$$;

-- Los límites se pueden personalizar por negocio. NULL significa que esa
-- métrica todavía no tiene límite configurado.
alter table public.businesses
  add column if not exists monthly_contact_limit integer,
  add column if not exists monthly_outbound_message_limit integer;

-- Los clientes actuales del plan económico reciben el límite recomendado.
-- Pro/Premium quedan intactos para no inventar condiciones comerciales.
do $$
begin
  if not exists (
    select 1 from public.message_usage_migration_state
    where key = 'limits_v1'
  ) then
    update public.businesses
    set monthly_contact_limit = coalesce(monthly_contact_limit, 50),
        monthly_outbound_message_limit =
          coalesce(monthly_outbound_message_limit, 250)
    where lower(coalesce(plan, 'basic')) in ('basic', 'micro', 'founder');

    insert into public.message_usage_migration_state (key)
    values ('limits_v1');
  end if;
end;
$$;

alter table public.businesses
  alter column monthly_contact_limit set default 50,
  alter column monthly_outbound_message_limit set default 250;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'businesses_monthly_contact_limit_check'
      and conrelid = 'public.businesses'::regclass
  ) then
    alter table public.businesses
      add constraint businesses_monthly_contact_limit_check
      check (
        monthly_contact_limit is null
        or monthly_contact_limit between 1 and 1000000
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'businesses_monthly_outbound_limit_check'
      and conrelid = 'public.businesses'::regclass
  ) then
    alter table public.businesses
      add constraint businesses_monthly_outbound_limit_check
      check (
        monthly_outbound_message_limit is null
        or monthly_outbound_message_limit between 1 and 10000000
      );
  end if;
end;
$$;

-- Libro mayor inmutable del consumo. No almacena teléfonos: usa un hash
-- estable por negocio/proveedor/contacto para poder contar únicos.
create table if not exists public.message_usage_events (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null
                    references public.businesses(id) on delete cascade,
  provider          text not null
                    check (provider in ('meta', 'ycloud', 'telegram', 'legacy')),
  direction         text not null check (direction in ('inbound', 'outbound')),
  message_type      text not null
                    check (message_type in (
                      'text', 'image', 'video', 'audio', 'interactive', 'other'
                    )),
  contact_key_hash  text not null
                    check (contact_key_hash ~ '^[0-9a-f]{64}$'),
  source_kind       text not null
                    check (source_kind in ('webhook', 'send', 'history')),
  source_key        text not null
                    check (char_length(source_key) between 1 and 200),
  occurred_at       timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  unique (business_id, source_key)
);

create index if not exists idx_message_usage_business_period
  on public.message_usage_events (business_id, occurred_at);
create index if not exists idx_message_usage_business_direction_period
  on public.message_usage_events (business_id, direction, occurred_at);
create index if not exists idx_message_usage_contact_period
  on public.message_usage_events (business_id, contact_key_hash, occurred_at);

-- Cada webhook nuevo ya está deduplicado por el inbox durable. El trigger
-- copia exactamente una unidad al histórico de consumo en la misma transacción.
-- `extensions` va en el search_path porque digest() pertenece a pgcrypto, que en
-- Supabase vive en ese esquema. Sin él la función falla con
-- "function digest(text, unknown) does not exist" y tumba TODO el ingreso de
-- WhatsApp: el trigger revienta al insertar, enqueue_webhook_event falla y el
-- webhook responde 503 hasta que el proveedor deja de entregar.
create or replace function public.record_inbound_message_usage()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_message_type text;
  v_inbound_hash text;
begin
  -- La RPC heredada claim_webhook_event inserta únicamente una marca
  -- completada, sin contacto ni payload. No representa un inbound procesable.
  if new.stream_key_hash is null then
    return new;
  end if;

  v_message_type := case new.payload #>> '{content,kind}'
    when 'text' then 'text'
    when 'image' then 'image'
    when 'audio' then 'audio'
    else 'other'
  end;
  v_inbound_hash := encode(digest(
    coalesce(nullif(new.payload ->> 'inboundId', ''), new.message_id_hash),
    'sha256'
  ), 'hex');

  insert into public.message_usage_events (
    business_id,
    provider,
    direction,
    message_type,
    contact_key_hash,
    source_kind,
    source_key,
    occurred_at
  ) values (
    new.business_id,
    new.provider,
    'inbound',
    v_message_type,
    new.stream_key_hash,
    'webhook',
    'inbound:' || new.provider || ':' || v_inbound_hash,
    new.received_at
  )
  on conflict (business_id, source_key) do nothing;

  return new;
end;
$$;

drop trigger if exists webhook_inbound_message_usage
  on public.webhook_inbound_events;
create trigger webhook_inbound_message_usage
after insert on public.webhook_inbound_events
for each row execute function public.record_inbound_message_usage();

-- Recupera el mes en curso desde el historial visible. Es una aproximación
-- inicial (no reconstruye multimedia antigua ni textos que fueron agrupados).
-- Los eventos posteriores a esta migración sí se registran físicamente.
-- Si la primera versión ya hizo backfill, su propia evidencia instala el
-- marcador antes de decidir. Así actualizar este archivo tampoco duplica.
insert into public.message_usage_migration_state (key, completed_at)
select 'conversation_history_v1', min(created_at)
from public.message_usage_events
where source_kind = 'history'
having count(*) > 0
on conflict (key) do nothing;

do $$
begin
  if not exists (
    select 1 from public.message_usage_migration_state
    where key = 'conversation_history_v1'
  ) then
    insert into public.message_usage_events (
      business_id,
      provider,
      direction,
      message_type,
      contact_key_hash,
      source_kind,
      source_key,
      occurred_at
    )
    select
      history.business_id,
      case
        when business.whatsapp_provider in ('meta', 'ycloud', 'telegram')
          then business.whatsapp_provider
        else 'legacy'
      end,
      case when history.role = 'user' then 'inbound' else 'outbound' end,
      'text',
      encode(digest(
        (
          case
            when business.whatsapp_provider in ('meta', 'ycloud', 'telegram')
              then business.whatsapp_provider
            else 'legacy'
          end
          || ':' || history.business_id::text
          || ':' || history.contact_phone
        ),
        'sha256'
      ), 'hex'),
      'history',
      'history:' || history.id::text,
      history.created_at
    from public.conversation_history as history
    join public.businesses as business on business.id = history.business_id
    where history.contact_phone <> 'sim_admin'
      and history.role in ('user', 'assistant', 'owner')
      and history.created_at >= (
        date_trunc('month', now() at time zone 'America/Guayaquil')
          at time zone 'America/Guayaquil'
      )
    on conflict (business_id, source_key) do nothing;

    insert into public.message_usage_migration_state (key)
    values ('conversation_history_v1');
  end if;
end;
$$;

-- Una sola consulta devuelve todos los negocios y evita N+1 desde el panel.
create or replace function public.get_admin_monthly_usage(
  p_month date default null
)
returns table (
  business_id uuid,
  period_start date,
  period_end date,
  active_contacts bigint,
  inbound_messages bigint,
  outbound_messages bigint,
  outbound_text_messages bigint,
  outbound_image_messages bigint,
  outbound_video_messages bigint,
  outbound_interactive_messages bigint,
  contact_limit integer,
  outbound_message_limit integer,
  contact_overage bigint,
  outbound_message_overage bigint,
  includes_history_estimate boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with bounds as (
    select
      date_trunc(
        'month',
        coalesce(p_month, (now() at time zone 'America/Guayaquil')::date)
      )::date as starts_on
  ),
  period_window as (
    select
      starts_on,
      (starts_on + interval '1 month')::date as ends_before,
      starts_on::timestamp at time zone 'America/Guayaquil' as starts_at,
      (starts_on + interval '1 month')::timestamp
        at time zone 'America/Guayaquil' as ends_at
    from bounds
  )
  select
    business.id as business_id,
    period_window.starts_on as period_start,
    (period_window.ends_before - 1) as period_end,
    count(distinct usage.contact_key_hash)
      filter (where usage.direction = 'inbound') as active_contacts,
    count(usage.id)
      filter (where usage.direction = 'inbound') as inbound_messages,
    count(usage.id)
      filter (where usage.direction = 'outbound') as outbound_messages,
    count(usage.id)
      filter (
        where usage.direction = 'outbound' and usage.message_type = 'text'
      ) as outbound_text_messages,
    count(usage.id)
      filter (
        where usage.direction = 'outbound' and usage.message_type = 'image'
      ) as outbound_image_messages,
    count(usage.id)
      filter (
        where usage.direction = 'outbound' and usage.message_type = 'video'
      ) as outbound_video_messages,
    count(usage.id)
      filter (
        where usage.direction = 'outbound'
          and usage.message_type = 'interactive'
      ) as outbound_interactive_messages,
    business.monthly_contact_limit as contact_limit,
    business.monthly_outbound_message_limit as outbound_message_limit,
    case
      when business.monthly_contact_limit is null then 0
      else greatest(
        count(distinct usage.contact_key_hash)
          filter (where usage.direction = 'inbound')
          - business.monthly_contact_limit,
        0
      )
    end as contact_overage,
    case
      when business.monthly_outbound_message_limit is null then 0
      else greatest(
        count(usage.id) filter (where usage.direction = 'outbound')
          - business.monthly_outbound_message_limit,
        0
      )
    end as outbound_message_overage,
    coalesce(
      bool_or(usage.source_kind = 'history')
        filter (where usage.id is not null),
      false
    ) as includes_history_estimate
  from public.businesses as business
  cross join period_window
  left join public.message_usage_events as usage
    on usage.business_id = business.id
   and usage.occurred_at >= period_window.starts_at
   and usage.occurred_at < period_window.ends_at
  group by
    business.id,
    business.created_at,
    business.monthly_contact_limit,
    business.monthly_outbound_message_limit,
    period_window.starts_on,
    period_window.ends_before
  order by business.created_at desc;
$$;

alter table public.message_usage_events enable row level security;
alter table public.message_usage_migration_state enable row level security;

revoke all on table public.message_usage_events
  from public, anon, authenticated;
grant select, insert on table public.message_usage_events
  to service_role;
revoke all on table public.message_usage_migration_state
  from public, anon, authenticated;

revoke all on function public.record_inbound_message_usage()
  from public, anon, authenticated;
revoke all on function public.get_admin_monthly_usage(date)
  from public, anon, authenticated;
grant execute on function public.get_admin_monthly_usage(date)
  to service_role;

commit;

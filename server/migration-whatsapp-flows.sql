-- ============================================================
-- WHATSAPP FLOWS MULTI-TENANT + FULFILLMENT + DESPACHO DIFERIDO
-- Fecha: 2026-07-28
--
-- Ejecutar en Supabase → SQL Editor antes de desplegar el runtime de Flows.
--
-- Esta migración es aditiva e idempotente:
--   • modela Flows reutilizables por capacidad, negocio, proveedor y WABA;
--   • conserva versiones locales y el identificador externo de cada versión;
--   • persiste únicamente hashes de tokens/contactos, nunca tokens en claro;
--   • deduplica submissions de forma atómica;
--   • registra métricas operativas básicas;
--   • añade fulfillment estructurado a los pedidos;
--   • crea un outbox HELD para el motorizado al confirmar un delivery.
--
-- IMPORTANTE: esta versión NO envía mensajes al motorizado y deliberadamente
-- no expone una RPC para liberar/arrendar el outbox. Solo deja el trabajo
-- guardado e idempotente para habilitar el worker en una fase posterior.
-- ============================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

create extension if not exists pgcrypto;

-- ── Fulfillment estructurado ────────────────────────────────
-- Las filas históricas conservan NULL (modalidad aún no especificada).
alter table public.orders
  add column if not exists fulfillment_type text,
  add column if not exists delivery_address text,
  add column if not exists delivery_reference text,
  add column if not exists payment_method text,
  add column if not exists requested_fulfillment_at timestamptz,
  add column if not exists customer_notes text,
  add column if not exists delivery_fee numeric(10,2) not null default 0;

alter table public.order_items
  add column if not exists line_number integer,
  add column if not exists modifier_ids uuid[] not null default '{}'::uuid[],
  add column if not exists modifier_names text[] not null default '{}'::text[],
  add column if not exists item_note text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_fulfillment_type_check'
  ) then
    alter table public.orders
      add constraint orders_fulfillment_type_check
      check (
        fulfillment_type is null
        or fulfillment_type in ('delivery', 'pickup', 'onsite')
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_delivery_fee_check'
  ) then
    alter table public.orders
      add constraint orders_delivery_fee_check
      check (delivery_fee >= 0 and delivery_fee <= 100000);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_fulfillment_text_lengths_check'
  ) then
    alter table public.orders
      add constraint orders_fulfillment_text_lengths_check
      check (
        char_length(coalesce(delivery_address, '')) <= 1000
        and char_length(coalesce(delivery_reference, '')) <= 500
        and char_length(coalesce(payment_method, '')) <= 120
        and char_length(coalesce(customer_notes, '')) <= 2000
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.order_items'::regclass
      and conname = 'order_items_flow_details_check'
  ) then
    alter table public.order_items
      add constraint order_items_flow_details_check
      check (
        (line_number is null or line_number between 1 and 100)
        and cardinality(modifier_ids) <= 20
        and cardinality(modifier_names) <= 20
        and cardinality(modifier_ids) = cardinality(modifier_names)
        and char_length(coalesce(item_note, '')) <= 500
      );
  end if;
end;
$$;

-- Permite FKs compuestas que comprueban el tenant además del UUID.
create unique index if not exists uq_orders_id_business
  on public.orders (id, business_id);
create unique index if not exists uq_order_items_line_number
  on public.order_items (order_id, line_number)
  where line_number is not null;

create or replace function public.normalize_order_fulfillment_total()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.delivery_fee := round(coalesce(new.delivery_fee, 0), 2);
  if new.delivery_fee < 0 or new.delivery_fee > 100000 then
    raise exception using
      errcode = '22023',
      message = 'La tarifa de entrega no es válida';
  end if;

  new.total := round(
    coalesce(new.subtotal, 0)
      - coalesce(new.discount, 0)
      + new.delivery_fee,
    2
  );
  return new;
end;
$$;

revoke all on function public.normalize_order_fulfillment_total()
  from public, anon, authenticated;

drop trigger if exists orders_normalize_fulfillment_total on public.orders;
create trigger orders_normalize_fulfillment_total
before insert or update of subtotal, discount, delivery_fee on public.orders
for each row execute function public.normalize_order_fulfillment_total();

create or replace function public.set_order_fulfillment(
  p_business_id uuid,
  p_order_id uuid,
  p_fulfillment_type text,
  p_delivery_address text default null,
  p_delivery_reference text default null,
  p_payment_method text default null,
  p_requested_fulfillment_at timestamptz default null,
  p_customer_notes text default null,
  p_delivery_fee numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_type text := lower(btrim(coalesce(p_fulfillment_type, '')));
  v_address text := nullif(btrim(coalesce(p_delivery_address, '')), '');
  v_reference text := nullif(btrim(coalesce(p_delivery_reference, '')), '');
  v_payment text := nullif(btrim(coalesce(p_payment_method, '')), '');
  v_notes text := nullif(btrim(coalesce(p_customer_notes, '')), '');
  v_fee numeric := round(coalesce(p_delivery_fee, 0), 2);
begin
  if p_business_id is null or p_order_id is null then
    raise exception using
      errcode = '22023',
      message = 'El negocio y el pedido son obligatorios';
  end if;
  if v_type not in ('delivery', 'pickup', 'onsite') then
    raise exception using
      errcode = '22023',
      message = 'La modalidad debe ser delivery, pickup u onsite';
  end if;
  if v_type = 'delivery' and v_address is null then
    raise exception using
      errcode = '22023',
      message = 'La dirección es obligatoria para delivery';
  end if;
  if v_fee < 0 or v_fee > 100000 then
    raise exception using
      errcode = '22023',
      message = 'La tarifa de entrega no es válida';
  end if;
  if v_type <> 'delivery' then
    v_address := null;
    v_reference := null;
    v_fee := 0;
  end if;

  update public.orders as target
  set fulfillment_type = v_type,
      delivery_address = v_address,
      delivery_reference = v_reference,
      payment_method = v_payment,
      requested_fulfillment_at = p_requested_fulfillment_at,
      customer_notes = v_notes,
      delivery_fee = v_fee,
      updated_at = now()
  where target.id = p_order_id
    and target.business_id = p_business_id
    and target.status in ('pendiente', 'confirmado')
  returning target.* into v_order;

  if not found then
    return jsonb_build_object('result', 'not_editable', 'order', null);
  end if;
  return jsonb_build_object('result', 'updated', 'order', to_jsonb(v_order));
end;
$$;

revoke all on function public.set_order_fulfillment(
  uuid, uuid, text, text, text, text, timestamptz, text, numeric
) from public, anon, authenticated;
grant execute on function public.set_order_fulfillment(
  uuid, uuid, text, text, text, text, timestamptz, text, numeric
) to service_role;

-- ── Definiciones y versiones de WhatsApp Flows ─────────────
-- capability_key es intencionalmente extensible: order, appointment, lodging,
-- lead y futuras capacidades sin migrar un enum por cada nuevo giro comercial.
create table if not exists public.whatsapp_flow_definitions (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null
                    references public.businesses(id) on delete cascade,
  provider          text not null check (provider in ('meta', 'ycloud')),
  waba_id            text not null,
  flow_key           text not null,
  capability_key     text not null,
  display_name       text not null,
  description        text,
  configuration      jsonb not null default '{}'::jsonb,
  enabled            boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint whatsapp_flow_definitions_waba_check check (
    waba_id = btrim(waba_id)
    and char_length(waba_id) between 1 and 255
    and waba_id !~ '[[:cntrl:]]'
  ),
  constraint whatsapp_flow_definitions_flow_key_check check (
    flow_key ~ '^[a-z][a-z0-9_.-]{1,63}$'
  ),
  constraint whatsapp_flow_definitions_capability_check check (
    capability_key ~ '^[a-z][a-z0-9_.-]{1,63}$'
  ),
  constraint whatsapp_flow_definitions_name_check check (
    display_name = btrim(display_name)
    and char_length(display_name) between 1 and 120
  ),
  constraint whatsapp_flow_definitions_description_check check (
    char_length(coalesce(description, '')) <= 1000
  ),
  constraint whatsapp_flow_definitions_configuration_check check (
    jsonb_typeof(configuration) = 'object'
    and pg_column_size(configuration) <= 262144
  ),
  unique (business_id, provider, waba_id, flow_key),
  unique (id, business_id, provider, waba_id)
);

create table if not exists public.whatsapp_flow_versions (
  id                         uuid primary key default gen_random_uuid(),
  flow_id                    uuid not null,
  business_id                uuid not null,
  provider                   text not null check (provider in ('meta', 'ycloud')),
  waba_id                     text not null,
  version                     integer not null check (version between 1 and 1000000),
  provider_flow_id            text,
  provider_version            text,
  status                      text not null default 'draft'
                              check (status in (
                                'draft',
                                'provisioning',
                                'published',
                                'deprecated',
                                'blocked',
                                'failed'
                              )),
  is_active                   boolean not null default false,
  flow_json                   jsonb not null,
  content_hash                text not null
                              check (content_hash ~ '^[0-9a-f]{64}$'),
  data_api_version            text,
  data_exchange_endpoint_path text,
  validation_errors           jsonb not null default '[]'::jsonb,
  published_at                timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint whatsapp_flow_versions_definition_fk foreign key (
    flow_id, business_id, provider, waba_id
  ) references public.whatsapp_flow_definitions (
    id, business_id, provider, waba_id
  ) on delete cascade,
  constraint whatsapp_flow_versions_provider_flow_id_check check (
    provider_flow_id is null
    or (
      provider_flow_id = btrim(provider_flow_id)
      and char_length(provider_flow_id) between 1 and 255
      and provider_flow_id !~ '[[:cntrl:]]'
    )
  ),
  constraint whatsapp_flow_versions_provider_version_check check (
    char_length(coalesce(provider_version, '')) <= 64
  ),
  constraint whatsapp_flow_versions_json_check check (
    jsonb_typeof(flow_json) = 'object'
    and pg_column_size(flow_json) <= 1048576
  ),
  constraint whatsapp_flow_versions_endpoint_path_check check (
    data_exchange_endpoint_path is null
    or (
      data_exchange_endpoint_path ~ '^/[A-Za-z0-9/_-]{1,500}$'
      and data_exchange_endpoint_path !~ '//'
    )
  ),
  constraint whatsapp_flow_versions_validation_errors_check check (
    jsonb_typeof(validation_errors) = 'array'
    and pg_column_size(validation_errors) <= 262144
  ),
  constraint whatsapp_flow_versions_active_check check (
    is_active is false or status = 'published'
  ),
  constraint whatsapp_flow_versions_published_check check (
    status <> 'published'
    or (provider_flow_id is not null and published_at is not null)
  ),
  unique (flow_id, version),
  unique (id, business_id, provider),
  unique (provider, waba_id, provider_flow_id)
);

create unique index if not exists uq_whatsapp_flow_active_version
  on public.whatsapp_flow_versions (flow_id)
  where is_active is true;
create unique index if not exists uq_whatsapp_flow_enabled_capability
  on public.whatsapp_flow_definitions (
    business_id, provider, capability_key
  )
  where enabled is true;
create index if not exists idx_whatsapp_flow_definitions_business
  on public.whatsapp_flow_definitions (
    business_id, capability_key, enabled, updated_at desc
  );
create index if not exists idx_whatsapp_flow_versions_definition
  on public.whatsapp_flow_versions (flow_id, version desc);
create index if not exists idx_whatsapp_flow_versions_external
  on public.whatsapp_flow_versions (provider, waba_id, provider_flow_id)
  where provider_flow_id is not null;

-- ── Sesiones, submissions y métricas ───────────────────────
create table if not exists public.whatsapp_flow_sessions (
  id                       uuid primary key default gen_random_uuid(),
  business_id              uuid not null
                           references public.businesses(id) on delete cascade,
  provider                 text not null check (provider in ('meta', 'ycloud')),
  flow_version_id          uuid not null,
  session_token_hash       text not null unique
                           check (session_token_hash ~ '^[0-9a-f]{64}$'),
  contact_key_hash         text not null
                           check (contact_key_hash ~ '^[0-9a-f]{64}$'),
  provider_message_id_hash text
                           check (
                             provider_message_id_hash is null
                             or provider_message_id_hash ~ '^[0-9a-f]{64}$'
                           ),
  status                   text not null default 'open'
                           check (status in (
                             'open', 'submitted', 'expired', 'cancelled'
                           )),
  context                  jsonb not null default '{}'::jsonb,
  context_revision         integer not null default 0
                           check (context_revision between 0 and 2147483647),
  expires_at               timestamptz not null,
  submitted_at             timestamptz,
  last_activity_at         timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint whatsapp_flow_sessions_version_fk foreign key (
    flow_version_id, business_id, provider
  ) references public.whatsapp_flow_versions (
    id, business_id, provider
  ) on delete cascade,
  constraint whatsapp_flow_sessions_context_check check (
    jsonb_typeof(context) = 'object'
    and pg_column_size(context) <= 65536
  ),
  constraint whatsapp_flow_sessions_expiration_check check (
    expires_at > created_at
  ),
  constraint whatsapp_flow_sessions_submission_state_check check (
    (status = 'submitted' and submitted_at is not null)
    or (status <> 'submitted' and submitted_at is null)
  ),
  unique (id, business_id, provider)
);

create table if not exists public.whatsapp_flow_submissions (
  id                           uuid primary key default gen_random_uuid(),
  business_id                  uuid not null
                               references public.businesses(id) on delete cascade,
  provider                     text not null check (provider in ('meta', 'ycloud')),
  session_id                   uuid not null,
  provider_submission_key_hash text not null
                               check (
                                 provider_submission_key_hash ~ '^[0-9a-f]{64}$'
                               ),
  payload                      jsonb not null,
  processing_status            text not null default 'received'
                               check (processing_status in (
                                 'received',
                                 'processing',
                                 'processed',
                                 'rejected',
                                 'failed'
                               )),
  order_id                     uuid,
  error_code                   text,
  processed_at                 timestamptz,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  constraint whatsapp_flow_submissions_session_fk foreign key (
    session_id, business_id, provider
  ) references public.whatsapp_flow_sessions (
    id, business_id, provider
  ) on delete cascade,
  constraint whatsapp_flow_submissions_order_fk foreign key (
    order_id, business_id
  ) references public.orders (id, business_id) on delete cascade,
  constraint whatsapp_flow_submissions_payload_check check (
    jsonb_typeof(payload) = 'object'
    and pg_column_size(payload) <= 262144
  ),
  constraint whatsapp_flow_submissions_error_check check (
    char_length(coalesce(error_code, '')) <= 120
  ),
  constraint whatsapp_flow_submissions_processed_check check (
    (
      processing_status in ('processed', 'rejected', 'failed')
      and processed_at is not null
    )
    or (
      processing_status in ('received', 'processing')
      and processed_at is null
    )
  ),
  unique (business_id, provider, provider_submission_key_hash),
  unique (session_id),
  unique (id, business_id)
);

-- Enlace inverso idempotente. Se agrega después de submissions para mantener
-- la instalación aditiva; el UUID nunca se acepta desde el cliente.
alter table public.orders
  add column if not exists flow_submission_id uuid;

create unique index if not exists uq_orders_flow_submission
  on public.orders (flow_submission_id)
  where flow_submission_id is not null;

create table if not exists public.whatsapp_flow_metric_events (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null
                      references public.businesses(id) on delete cascade,
  provider            text not null check (provider in ('meta', 'ycloud')),
  flow_version_id     uuid not null,
  session_id          uuid,
  event_type          text not null
                      check (event_type ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  metric_value        integer not null default 1
                      check (metric_value between 1 and 1000000),
  source_key_hash     text not null
                      check (source_key_hash ~ '^[0-9a-f]{64}$'),
  metadata            jsonb not null default '{}'::jsonb,
  occurred_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  constraint whatsapp_flow_metrics_version_fk foreign key (
    flow_version_id, business_id, provider
  ) references public.whatsapp_flow_versions (
    id, business_id, provider
  ) on delete cascade,
  constraint whatsapp_flow_metrics_session_fk foreign key (
    session_id, business_id, provider
  ) references public.whatsapp_flow_sessions (
    id, business_id, provider
  ) on delete cascade,
  constraint whatsapp_flow_metrics_metadata_check check (
    jsonb_typeof(metadata) = 'object'
    and pg_column_size(metadata) <= 16384
  ),
  unique (business_id, event_type, source_key_hash)
);

create index if not exists idx_whatsapp_flow_sessions_open_expiry
  on public.whatsapp_flow_sessions (expires_at, id)
  where status = 'open';
create index if not exists idx_whatsapp_flow_sessions_business_contact
  on public.whatsapp_flow_sessions (
    business_id, contact_key_hash, created_at desc
  );
create index if not exists idx_whatsapp_flow_submissions_processing
  on public.whatsapp_flow_submissions (
    business_id, processing_status, created_at, id
  );
create index if not exists idx_whatsapp_flow_metrics_business_period
  on public.whatsapp_flow_metric_events (
    business_id, occurred_at, flow_version_id, event_type
  );

-- ── Motorizados y outbox retenido ──────────────────────────
create table if not exists public.delivery_dispatch_recipients (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null
                references public.businesses(id) on delete cascade,
  recipient_key text not null,
  display_name  text not null,
  provider      text not null check (provider in ('meta', 'ycloud')),
  phone_e164    text not null,
  priority      integer not null default 100 check (priority between 0 and 10000),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint delivery_dispatch_recipients_key_check check (
    recipient_key ~ '^[a-z][a-z0-9_.-]{1,63}$'
  ),
  constraint delivery_dispatch_recipients_name_check check (
    display_name = btrim(display_name)
    and char_length(display_name) between 1 and 120
  ),
  constraint delivery_dispatch_recipients_phone_check check (
    phone_e164 ~ '^[1-9][0-9]{7,14}$'
  ),
  unique (business_id, recipient_key),
  unique (business_id, provider, phone_e164),
  unique (id, business_id, provider)
);

create table if not exists public.delivery_dispatch_outbox (
  id                       uuid primary key default gen_random_uuid(),
  business_id              uuid not null
                           references public.businesses(id) on delete cascade,
  order_id                 uuid not null,
  recipient_id             uuid,
  provider                 text check (provider in ('meta', 'ycloud')),
  event_type               text not null default 'order.confirmed'
                           check (event_type ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  message_template_key     text not null default 'order_confirmed_driver'
                           check (
                             message_template_key ~ '^[a-z][a-z0-9_.-]{1,63}$'
                           ),
  status                   text not null default 'held'
                           check (status in (
                             'held',
                             'pending',
                             'processing',
                             'sent',
                             'failed',
                             'cancelled'
                           )),
  deduplication_key_hash   text not null
                           check (deduplication_key_hash ~ '^[0-9a-f]{64}$'),
  payload                  jsonb not null,
  attempts                 integer not null default 0
                           check (attempts between 0 and 100),
  available_at             timestamptz not null default now(),
  provider_message_id_hash text
                           check (
                             provider_message_id_hash is null
                             or provider_message_id_hash ~ '^[0-9a-f]{64}$'
                           ),
  last_error_code          text,
  released_at              timestamptz,
  sent_at                  timestamptz,
  cancelled_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint delivery_dispatch_outbox_order_fk foreign key (
    order_id, business_id
  ) references public.orders (id, business_id) on delete cascade,
  constraint delivery_dispatch_outbox_recipient_fk foreign key (
    recipient_id, business_id, provider
  ) references public.delivery_dispatch_recipients (
    id, business_id, provider
  ) on delete cascade,
  constraint delivery_dispatch_outbox_payload_check check (
    jsonb_typeof(payload) = 'object'
    and pg_column_size(payload) <= 65536
  ),
  constraint delivery_dispatch_outbox_error_check check (
    char_length(coalesce(last_error_code, '')) <= 120
  ),
  constraint delivery_dispatch_outbox_recipient_check check (
    (recipient_id is null and provider is null)
    or (recipient_id is not null and provider is not null)
  ),
  constraint delivery_dispatch_outbox_terminal_check check (
    (status = 'sent' and sent_at is not null and cancelled_at is null)
    or (status = 'cancelled' and cancelled_at is not null and sent_at is null)
    or (
      status not in ('sent', 'cancelled')
      and sent_at is null
      and cancelled_at is null
    )
  ),
  unique (business_id, order_id, event_type),
  unique (business_id, deduplication_key_hash)
);

create index if not exists idx_delivery_recipients_business_priority
  on public.delivery_dispatch_recipients (
    business_id, active, priority, created_at
  );
create index if not exists idx_delivery_dispatch_outbox_held
  on public.delivery_dispatch_outbox (
    business_id, created_at, id
  )
  where status = 'held';

-- ── RPCs atómicas de Flows ─────────────────────────────────
create or replace function public.create_whatsapp_flow_version(
  p_business_id uuid,
  p_flow_id uuid,
  p_flow_json jsonb,
  p_provider_flow_id text default null,
  p_provider_version text default null,
  p_data_api_version text default null,
  p_data_exchange_endpoint_path text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_definition public.whatsapp_flow_definitions%rowtype;
  v_version public.whatsapp_flow_versions%rowtype;
  v_next_version integer;
begin
  if jsonb_typeof(p_flow_json) is distinct from 'object'
     or pg_column_size(p_flow_json) > 1048576 then
    raise exception using
      errcode = '22023',
      message = 'El JSON del Flow no es válido';
  end if;

  select definition.*
  into v_definition
  from public.whatsapp_flow_definitions as definition
  where definition.id = p_flow_id
    and definition.business_id = p_business_id
  for update;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'El Flow no pertenece al negocio';
  end if;

  select coalesce(max(flow_version.version), 0) + 1
  into v_next_version
  from public.whatsapp_flow_versions as flow_version
  where flow_version.flow_id = v_definition.id;

  insert into public.whatsapp_flow_versions (
    flow_id,
    business_id,
    provider,
    waba_id,
    version,
    provider_flow_id,
    provider_version,
    status,
    is_active,
    flow_json,
    content_hash,
    data_api_version,
    data_exchange_endpoint_path
  ) values (
    v_definition.id,
    v_definition.business_id,
    v_definition.provider,
    v_definition.waba_id,
    v_next_version,
    nullif(btrim(coalesce(p_provider_flow_id, '')), ''),
    nullif(btrim(coalesce(p_provider_version, '')), ''),
    'draft',
    false,
    p_flow_json,
    encode(digest(convert_to(p_flow_json::text, 'UTF8'), 'sha256'), 'hex'),
    nullif(btrim(coalesce(p_data_api_version, '')), ''),
    nullif(btrim(coalesce(p_data_exchange_endpoint_path, '')), '')
  )
  returning * into v_version;

  return to_jsonb(v_version);
end;
$$;

create or replace function public.activate_whatsapp_flow_version(
  p_business_id uuid,
  p_flow_version_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_version public.whatsapp_flow_versions%rowtype;
begin
  select flow_version.*
  into v_version
  from public.whatsapp_flow_versions as flow_version
  where flow_version.id = p_flow_version_id
    and flow_version.business_id = p_business_id
  for update;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'La versión no pertenece al negocio';
  end if;
  if v_version.status <> 'published' then
    raise exception using
      errcode = '22023',
      message = 'Solo una versión publicada puede activarse';
  end if;
  if v_version.provider_flow_id is null then
    raise exception using
      errcode = '22023',
      message = 'Una versión sin identificador del proveedor no puede activarse';
  end if;

  update public.whatsapp_flow_versions
  set is_active = false,
      updated_at = now()
  where flow_id = v_version.flow_id
    and is_active is true
    and id <> v_version.id;

  update public.whatsapp_flow_versions
  set is_active = true,
      updated_at = now()
  where id = v_version.id
  returning * into v_version;

  -- Publicar/activar una versión y habilitarla para clientes son decisiones
  -- separadas. La definición conserva su `enabled` actual hasta que el
  -- superadmin la cambie explícitamente desde el panel.
  return to_jsonb(v_version);
end;
$$;

create or replace function public.enforce_enabled_whatsapp_flow_definition()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.enabled is true and not exists (
    select 1
    from public.whatsapp_flow_versions as flow_version
    where flow_version.flow_id = new.id
      and flow_version.business_id = new.business_id
      and flow_version.provider = new.provider
      and flow_version.status = 'published'
      and flow_version.is_active is true
      and flow_version.provider_flow_id is not null
  ) then
    raise exception using
      errcode = '23514',
      message = 'Solo un Flow publicado y activo puede habilitarse';
  end if;
  return new;
end;
$$;

drop trigger if exists whatsapp_flow_definition_enabled_guard
  on public.whatsapp_flow_definitions;
create trigger whatsapp_flow_definition_enabled_guard
before insert or update of enabled on public.whatsapp_flow_definitions
for each row execute function public.enforce_enabled_whatsapp_flow_definition();

create or replace function public.create_whatsapp_flow_session(
  p_business_id uuid,
  p_provider text,
  p_flow_version_id uuid,
  p_session_token_hash text,
  p_contact_key_hash text,
  p_expires_at timestamptz,
  p_context jsonb default '{}'::jsonb,
  p_provider_message_id_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_version public.whatsapp_flow_versions%rowtype;
  v_session public.whatsapp_flow_sessions%rowtype;
begin
  if p_provider not in ('meta', 'ycloud')
     or p_session_token_hash !~ '^[0-9a-f]{64}$'
     or p_contact_key_hash !~ '^[0-9a-f]{64}$'
     or (
       p_provider_message_id_hash is not null
       and p_provider_message_id_hash !~ '^[0-9a-f]{64}$'
     ) then
    raise exception using
      errcode = '22023',
      message = 'Los identificadores de sesión no son válidos';
  end if;
  if p_expires_at <= now()
     or p_expires_at > now() + interval '7 days' then
    raise exception using
      errcode = '22023',
      message = 'La expiración de la sesión no es válida';
  end if;
  if jsonb_typeof(p_context) is distinct from 'object'
     or pg_column_size(p_context) > 65536 then
    raise exception using
      errcode = '22023',
      message = 'El contexto de la sesión no es válido';
  end if;

  select flow_version.*
  into v_version
  from public.whatsapp_flow_versions as flow_version
  join public.whatsapp_flow_definitions as definition
    on definition.id = flow_version.flow_id
   and definition.business_id = flow_version.business_id
  where flow_version.id = p_flow_version_id
    and flow_version.business_id = p_business_id
    and flow_version.provider = p_provider
    and flow_version.status = 'published'
    and flow_version.is_active is true
    and definition.enabled is true;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'El Flow activo no pertenece al negocio';
  end if;

  insert into public.whatsapp_flow_sessions (
    business_id,
    provider,
    flow_version_id,
    session_token_hash,
    contact_key_hash,
    provider_message_id_hash,
    context,
    expires_at
  ) values (
    p_business_id,
    v_version.provider,
    v_version.id,
    p_session_token_hash,
    p_contact_key_hash,
    p_provider_message_id_hash,
    p_context,
    p_expires_at
  )
  returning * into v_session;

  return jsonb_build_object(
    'id', v_session.id,
    'business_id', v_session.business_id,
    'provider', v_session.provider,
    'flow_version_id', v_session.flow_version_id,
    'status', v_session.status,
    'context', v_session.context,
    'context_revision', v_session.context_revision,
    'expires_at', v_session.expires_at,
    'created_at', v_session.created_at
  );
end;
$$;

create or replace function public.record_whatsapp_flow_submission(
  p_business_id uuid,
  p_provider text,
  p_session_token_hash text,
  p_contact_key_hash text,
  p_submission_key_hash text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.whatsapp_flow_sessions%rowtype;
  v_submission public.whatsapp_flow_submissions%rowtype;
begin
  if p_provider not in ('meta', 'ycloud') then
    raise exception using
      errcode = '22023',
      message = 'Proveedor de Flow no válido';
  end if;
  if p_session_token_hash !~ '^[0-9a-f]{64}$'
     or p_contact_key_hash !~ '^[0-9a-f]{64}$'
     or p_submission_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'Los identificadores de submission no son válidos';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object'
     or pg_column_size(p_payload) > 262144 then
    raise exception using
      errcode = '22023',
      message = 'El payload del Flow no es válido';
  end if;

  select session.*
  into v_session
  from public.whatsapp_flow_sessions as session
  where session.business_id = p_business_id
    and session.provider = p_provider
    and session.session_token_hash = p_session_token_hash
    and session.contact_key_hash = p_contact_key_hash
  for update;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'La sesión del Flow no pertenece al negocio';
  end if;

  -- Una redelivery devuelve la fila original únicamente después de comprobar
  -- que token, tenant, proveedor y contacto corresponden a esa misma sesión.
  select submission.*
  into v_submission
  from public.whatsapp_flow_submissions as submission
  where submission.business_id = p_business_id
    and submission.provider = p_provider
    and submission.session_id = v_session.id
    and submission.provider_submission_key_hash = p_submission_key_hash;

  if found then
    return jsonb_build_object(
      'created', false,
      'submission', to_jsonb(v_submission)
    );
  end if;

  select submission.*
  into v_submission
  from public.whatsapp_flow_submissions as submission
  where submission.session_id = v_session.id;

  if found then
    return jsonb_build_object(
      'created', false,
      'submission', to_jsonb(v_submission)
    );
  end if;

  if v_session.status <> 'open' or v_session.expires_at <= now() then
    if v_session.status = 'open' and v_session.expires_at <= now() then
      update public.whatsapp_flow_sessions
      set status = 'expired',
          updated_at = now(),
          last_activity_at = now()
      where id = v_session.id;
    end if;
    return jsonb_build_object(
      'created', false,
      'result', 'unavailable',
      'submission', null
    );
  end if;

  insert into public.whatsapp_flow_submissions (
    business_id,
    provider,
    session_id,
    provider_submission_key_hash,
    payload
  ) values (
    p_business_id,
    p_provider,
    v_session.id,
    p_submission_key_hash,
    p_payload
  )
  returning * into v_submission;

  update public.whatsapp_flow_sessions
  set status = 'submitted',
      submitted_at = now(),
      last_activity_at = now(),
      updated_at = now()
  where id = v_session.id;

  return jsonb_build_object(
    'created', true,
    'submission', to_jsonb(v_submission)
  );
end;
$$;

-- Resuelve una sesión por el hash de un token de alta entropía. La respuesta
-- excluye expresamente session_token_hash, contact_key_hash y message hashes.
create or replace function public.resolve_whatsapp_flow_session(
  p_provider text,
  p_session_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.whatsapp_flow_sessions%rowtype;
  v_flow record;
begin
  if p_provider not in ('meta', 'ycloud')
     or p_session_token_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  select session.*
  into v_session
  from public.whatsapp_flow_sessions as session
  where session.provider = p_provider
    and session.session_token_hash = p_session_token_hash
  for update;

  if not found then return null; end if;

  if v_session.status = 'open' and v_session.expires_at <= now() then
    update public.whatsapp_flow_sessions
    set status = 'expired',
        last_activity_at = now(),
        updated_at = now()
    where id = v_session.id
    returning * into v_session;
  end if;

  select
    definition.id as flow_id,
    definition.flow_key,
    definition.capability_key,
    flow_version.version,
    flow_version.provider_flow_id
  into v_flow
  from public.whatsapp_flow_versions as flow_version
  join public.whatsapp_flow_definitions as definition
    on definition.id = flow_version.flow_id
   and definition.business_id = flow_version.business_id
  where flow_version.id = v_session.flow_version_id
    and flow_version.business_id = v_session.business_id;

  return jsonb_build_object(
    'id', v_session.id,
    'business_id', v_session.business_id,
    'provider', v_session.provider,
    'flow_version_id', v_session.flow_version_id,
    'status', v_session.status,
    'context', v_session.context,
    'context_revision', v_session.context_revision,
    'expires_at', v_session.expires_at,
    'flow', jsonb_build_object(
      'id', v_flow.flow_id,
      'flow_key', v_flow.flow_key,
      'capability_key', v_flow.capability_key,
      'version', v_flow.version,
      'provider_flow_id', v_flow.provider_flow_id
    )
  );
end;
$$;

-- Compare-and-swap: dos requests DATA_EXCHANGE simultáneos no se pisan. El
-- caller recibe "stale" y puede releer la revisión vigente antes de reintentar.
create or replace function public.update_whatsapp_flow_session_context(
  p_business_id uuid,
  p_provider text,
  p_session_token_hash text,
  p_expected_revision integer,
  p_context jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.whatsapp_flow_sessions%rowtype;
begin
  if p_provider not in ('meta', 'ycloud')
     or p_session_token_hash !~ '^[0-9a-f]{64}$'
     or p_expected_revision < 0 then
    raise exception using
      errcode = '22023',
      message = 'Los datos de sesión no son válidos';
  end if;
  if jsonb_typeof(p_context) is distinct from 'object'
     or pg_column_size(p_context) > 65536 then
    raise exception using
      errcode = '22023',
      message = 'El contexto de la sesión no es válido';
  end if;

  select session.*
  into v_session
  from public.whatsapp_flow_sessions as session
  where session.business_id = p_business_id
    and session.provider = p_provider
    and session.session_token_hash = p_session_token_hash
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found', 'session', null);
  end if;
  if v_session.status <> 'open' or v_session.expires_at <= now() then
    if v_session.status = 'open' and v_session.expires_at <= now() then
      update public.whatsapp_flow_sessions
      set status = 'expired',
          last_activity_at = now(),
          updated_at = now()
      where id = v_session.id
      returning * into v_session;
    end if;
    return jsonb_build_object(
      'result', 'unavailable',
      'session', jsonb_build_object(
        'id', v_session.id,
        'business_id', v_session.business_id,
        'provider', v_session.provider,
        'flow_version_id', v_session.flow_version_id,
        'status', v_session.status,
        'context', v_session.context,
        'context_revision', v_session.context_revision,
        'expires_at', v_session.expires_at
      )
    );
  end if;
  if v_session.context_revision <> p_expected_revision then
    return jsonb_build_object(
      'result', 'stale',
      'session', jsonb_build_object(
        'id', v_session.id,
        'business_id', v_session.business_id,
        'provider', v_session.provider,
        'flow_version_id', v_session.flow_version_id,
        'status', v_session.status,
        'context', v_session.context,
        'context_revision', v_session.context_revision,
        'expires_at', v_session.expires_at
      )
    );
  end if;

  update public.whatsapp_flow_sessions
  set context = p_context,
      context_revision = context_revision + 1,
      last_activity_at = now(),
      updated_at = now()
  where id = v_session.id
  returning * into v_session;

  return jsonb_build_object(
    'result', 'updated',
    'session', jsonb_build_object(
      'id', v_session.id,
      'business_id', v_session.business_id,
      'provider', v_session.provider,
      'flow_version_id', v_session.flow_version_id,
      'status', v_session.status,
      'context', v_session.context,
      'context_revision', v_session.context_revision,
      'expires_at', v_session.expires_at
    )
  );
end;
$$;

create or replace function public.complete_whatsapp_flow_submission(
  p_business_id uuid,
  p_submission_id uuid,
  p_processing_status text,
  p_order_id uuid default null,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_submission public.whatsapp_flow_submissions%rowtype;
begin
  if p_processing_status not in ('processed', 'rejected', 'failed') then
    raise exception using
      errcode = '22023',
      message = 'El resultado de procesamiento no es válido';
  end if;
  if p_processing_status <> 'processed' and p_order_id is not null then
    raise exception using
      errcode = '22023',
      message = 'Un submission rechazado o fallido no puede enlazar un pedido';
  end if;
  if p_order_id is not null and not exists (
    select 1
    from public.orders
    where id = p_order_id
      and business_id = p_business_id
  ) then
    raise exception using
      errcode = '42501',
      message = 'El pedido no pertenece al negocio';
  end if;

  update public.whatsapp_flow_submissions as submission
  set processing_status = p_processing_status,
      order_id = p_order_id,
      error_code = nullif(btrim(coalesce(p_error_code, '')), ''),
      processed_at = now(),
      updated_at = now()
  where submission.id = p_submission_id
    and submission.business_id = p_business_id
    and submission.processing_status in ('received', 'processing')
  returning submission.* into v_submission;

  if not found then
    select submission.*
    into v_submission
    from public.whatsapp_flow_submissions as submission
    where submission.id = p_submission_id
      and submission.business_id = p_business_id;
  end if;

  return case
    when v_submission.id is null then null
    else to_jsonb(v_submission)
  end;
end;
$$;

-- Crea un pedido exactamente una vez desde un submission. p_items solo aporta
-- product_id, quantity, modifier_ids y note: nombre, disponibilidad y precio
-- se leen del catálogo del tenant. Los modificadores actuales son gratuitos.
create or replace function public.create_order_from_flow_submission(
  p_business_id uuid,
  p_submission_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_items jsonb,
  p_fulfillment_type text,
  p_delivery_address text default null,
  p_delivery_reference text default null,
  p_payment_method text default null,
  p_requested_fulfillment_at timestamptz default null,
  p_customer_notes text default null,
  p_delivery_fee numeric default 0,
  p_currency text default 'USD'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_submission public.whatsapp_flow_submissions%rowtype;
  v_session record;
  v_existing_order public.orders%rowtype;
  v_item jsonb;
  v_product public.products%rowtype;
  v_modifier public.menu_modifiers%rowtype;
  v_product_id uuid;
  v_modifier_id uuid;
  v_modifier_value text;
  v_quantity integer;
  v_unit_price numeric(10,2);
  v_line_total numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_line_number integer := 0;
  v_modifier_ids uuid[];
  v_modifier_names text[];
  v_item_note text;
  v_canonical_items jsonb := '[]'::jsonb;
  v_order_id uuid;
  v_fulfillment_result jsonb;
  v_final_order public.orders%rowtype;
begin
  if p_business_id is null
     or p_submission_id is null
     or nullif(btrim(coalesce(p_contact_phone, '')), '') is null then
    raise exception using
      errcode = '22023',
      message = 'Negocio, submission y contacto son obligatorios';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) < 1
     or jsonb_array_length(p_items) > 100 then
    raise exception using
      errcode = '22023',
      message = 'El pedido necesita entre 1 y 100 ítems';
  end if;

  select submission.*
  into v_submission
  from public.whatsapp_flow_submissions as submission
  where submission.id = p_submission_id
    and submission.business_id = p_business_id
  for update;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'El submission no pertenece al negocio';
  end if;

  if v_submission.order_id is not null then
    select target.*
    into v_existing_order
    from public.orders as target
    where target.id = v_submission.order_id
      and target.business_id = p_business_id;

    if found then
      return jsonb_build_object(
        'created', false,
        'order', to_jsonb(v_existing_order)
      );
    end if;
  end if;

  select session.*, definition.capability_key as resolved_capability_key
  into v_session
  from public.whatsapp_flow_sessions as session
  join public.whatsapp_flow_versions as flow_version
    on flow_version.id = session.flow_version_id
   and flow_version.business_id = session.business_id
  join public.whatsapp_flow_definitions as definition
    on definition.id = flow_version.flow_id
   and definition.business_id = flow_version.business_id
  where session.id = v_submission.session_id
    and session.business_id = p_business_id
  for update of session;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'La sesión del submission no pertenece al negocio';
  end if;
  if not (
    v_session.resolved_capability_key = 'order'
    or v_session.resolved_capability_key like 'order.%'
  ) then
    raise exception using
      errcode = '22023',
      message = 'El Flow no tiene capacidad de pedidos';
  end if;
  if v_session.contact_key_hash <> encode(digest(convert_to(
    v_session.provider
      || ':' || p_business_id::text
      || ':' || btrim(p_contact_phone),
    'UTF8'
  ), 'sha256'), 'hex') then
    raise exception using
      errcode = '42501',
      message = 'El contacto no corresponde a la sesión del Flow';
  end if;
  if v_submission.processing_status not in ('received', 'processing') then
    raise exception using
      errcode = '22023',
      message = 'El submission ya no puede crear un pedido';
  end if;

  update public.whatsapp_flow_submissions
  set processing_status = 'processing',
      updated_at = now()
  where id = v_submission.id;

  -- Se ignoran cualquier nombre, precio, total o tenant enviado en p_items.
  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) is distinct from 'object' then
      raise exception using
        errcode = '22023',
        message = 'Cada ítem debe ser un objeto';
    end if;

    begin
      v_product_id := nullif(v_item ->> 'product_id', '')::uuid;
      v_quantity := (v_item ->> 'quantity')::integer;
    exception
      when invalid_text_representation then
        raise exception using
          errcode = '22023',
          message = 'El producto o la cantidad no son válidos';
    end;

    if v_product_id is null
       or v_quantity is null
       or v_quantity < 1
       or v_quantity > 99 then
      raise exception using
        errcode = '22023',
        message = 'El producto y una cantidad entre 1 y 99 son obligatorios';
    end if;

    select product.*
    into v_product
    from public.products as product
    where product.id = v_product_id
      and product.business_id = p_business_id
      and product.active is true
    for share;

    if not found then
      raise exception using
        errcode = '42501',
        message = 'El producto no pertenece al negocio';
    end if;
    if v_product.stock = 'agotado' then
      raise exception using
        errcode = '22023',
        message = 'Uno de los productos está agotado';
    end if;
    if not (
      round(
        case
          when v_product.price_sale > 0 then v_product.price_sale
          else v_product.price
        end,
        2
      ) > 0
    ) then
      raise exception using
        errcode = '22023',
        message = 'Uno de los productos no tiene precio válido';
    end if;

    v_modifier_ids := '{}'::uuid[];
    v_modifier_names := '{}'::text[];
    v_item_note := nullif(btrim(coalesce(v_item ->> 'note', '')), '');
    if char_length(coalesce(v_item_note, '')) > 500 then
      raise exception using
        errcode = '22023',
        message = 'La nota de un ítem es demasiado larga';
    end if;
    if v_item ? 'modifier_ids'
       and jsonb_typeof(v_item -> 'modifier_ids') is distinct from 'array' then
      raise exception using
        errcode = '22023',
        message = 'Los modificadores deben ser una lista';
    end if;
    if jsonb_array_length(coalesce(v_item -> 'modifier_ids', '[]'::jsonb)) > 20 then
      raise exception using
        errcode = '22023',
        message = 'Un ítem no puede tener más de 20 modificadores';
    end if;

    for v_modifier_value in
      select value
      from jsonb_array_elements_text(
        coalesce(v_item -> 'modifier_ids', '[]'::jsonb)
      )
    loop
      begin
        v_modifier_id := v_modifier_value::uuid;
      exception
        when invalid_text_representation then
          raise exception using
            errcode = '22023',
            message = 'Uno de los modificadores no es válido';
      end;

      if v_modifier_id = any(v_modifier_ids) then
        continue;
      end if;

      select modifier.*
      into v_modifier
      from public.menu_modifiers as modifier
      where modifier.id = v_modifier_id
        and modifier.business_id = p_business_id
        and modifier.active is true
        and exists (
          select 1
          from unnest(
            coalesce(v_product.tags, '{}'::text[])
          ) as product_tag(value)
          where regexp_replace(
            translate(
              lower(btrim(product_tag.value)),
              'áéíóúüñ',
              'aeiouun'
            ),
            '[^a-z0-9]+',
            '',
            'g'
          ) = regexp_replace(
            translate(
              lower(btrim(modifier.category_tag)),
              'áéíóúüñ',
              'aeiouun'
            ),
            '[^a-z0-9]+',
            '',
            'g'
          )
        )
      for share;

      if not found then
        raise exception using
          errcode = '42501',
          message = 'El modificador no corresponde al producto o negocio';
      end if;

      v_modifier_ids := array_append(v_modifier_ids, v_modifier.id);
      v_modifier_names := array_append(v_modifier_names, v_modifier.name);
    end loop;

    v_unit_price := round(
      case
        when v_product.price_sale > 0 then v_product.price_sale
        else v_product.price
      end,
      2
    );
    v_line_total := round(v_unit_price * v_quantity, 2);
    v_subtotal := v_subtotal + v_line_total;
    v_line_number := v_line_number + 1;
    v_canonical_items := v_canonical_items || jsonb_build_array(
      jsonb_build_object(
        'line_number', v_line_number,
        'product_id', v_product.id,
        'product_name', v_product.name,
        'quantity', v_quantity,
        'unit_price', v_unit_price,
        'line_total', v_line_total,
        'modifier_ids', to_jsonb(v_modifier_ids),
        'modifier_names', to_jsonb(v_modifier_names),
        'item_note', v_item_note
      )
    );
  end loop;

  v_subtotal := round(v_subtotal, 2);
  insert into public.orders (
    business_id,
    contact_phone,
    contact_name,
    status,
    subtotal,
    discount,
    total,
    currency,
    flow_submission_id
  ) values (
    p_business_id,
    btrim(p_contact_phone),
    nullif(btrim(coalesce(p_contact_name, '')), ''),
    'pendiente',
    v_subtotal,
    0,
    v_subtotal,
    coalesce(nullif(btrim(coalesce(p_currency, '')), ''), 'USD'),
    v_submission.id
  )
  returning id into v_order_id;

  for v_item in select value from jsonb_array_elements(v_canonical_items)
  loop
    insert into public.order_items (
      order_id,
      business_id,
      line_number,
      product_id,
      product_name,
      quantity,
      unit_price,
      line_total,
      modifier_ids,
      modifier_names,
      item_note
    ) values (
      v_order_id,
      p_business_id,
      (v_item ->> 'line_number')::integer,
      (v_item ->> 'product_id')::uuid,
      v_item ->> 'product_name',
      (v_item ->> 'quantity')::integer,
      (v_item ->> 'unit_price')::numeric,
      (v_item ->> 'line_total')::numeric,
      array(
        select value::uuid
        from jsonb_array_elements_text(v_item -> 'modifier_ids')
      ),
      array(
        select value
        from jsonb_array_elements_text(v_item -> 'modifier_names')
      ),
      nullif(v_item ->> 'item_note', '')
    );
  end loop;

  v_fulfillment_result := public.set_order_fulfillment(
    p_business_id,
    v_order_id,
    p_fulfillment_type,
    p_delivery_address,
    p_delivery_reference,
    p_payment_method,
    p_requested_fulfillment_at,
    p_customer_notes,
    p_delivery_fee
  );
  if v_fulfillment_result ->> 'result' <> 'updated' then
    raise exception using
      errcode = 'P0001',
      message = 'No se pudo guardar el fulfillment del pedido';
  end if;

  update public.whatsapp_flow_submissions
  set processing_status = 'processed',
      order_id = v_order_id,
      error_code = null,
      processed_at = now(),
      updated_at = now()
  where id = v_submission.id;

  update public.whatsapp_flow_sessions
  set status = 'submitted',
      submitted_at = coalesce(submitted_at, now()),
      last_activity_at = now(),
      updated_at = now()
  where id = v_session.id;

  select target.*
  into v_final_order
  from public.orders as target
  where target.id = v_order_id
    and target.business_id = p_business_id;

  return jsonb_build_object(
    'created', true,
    'order', to_jsonb(v_final_order)
  );
end;
$$;

create or replace function public.record_whatsapp_flow_metric(
  p_business_id uuid,
  p_provider text,
  p_flow_version_id uuid,
  p_session_id uuid,
  p_event_type text,
  p_source_key_hash text,
  p_metadata jsonb default '{}'::jsonb,
  p_occurred_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inserted integer;
begin
  if p_event_type !~ '^[a-z][a-z0-9_.-]{1,63}$'
     or p_source_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'La métrica del Flow no es válida';
  end if;
  if jsonb_typeof(p_metadata) is distinct from 'object'
     or pg_column_size(p_metadata) > 16384 then
    raise exception using
      errcode = '22023',
      message = 'Los metadatos de la métrica no son válidos';
  end if;
  if not exists (
    select 1
    from public.whatsapp_flow_versions
    where id = p_flow_version_id
      and business_id = p_business_id
      and provider = p_provider
  ) then
    raise exception using
      errcode = '42501',
      message = 'La versión del Flow no pertenece al negocio';
  end if;
  if p_session_id is not null and not exists (
    select 1
    from public.whatsapp_flow_sessions
    where id = p_session_id
      and business_id = p_business_id
      and provider = p_provider
      and flow_version_id = p_flow_version_id
  ) then
    raise exception using
      errcode = '42501',
      message = 'La sesión no pertenece al Flow';
  end if;

  insert into public.whatsapp_flow_metric_events (
    business_id,
    provider,
    flow_version_id,
    session_id,
    event_type,
    source_key_hash,
    metadata,
    occurred_at
  ) values (
    p_business_id,
    p_provider,
    p_flow_version_id,
    p_session_id,
    p_event_type,
    p_source_key_hash,
    p_metadata,
    coalesce(p_occurred_at, now())
  )
  on conflict (business_id, event_type, source_key_hash) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end;
$$;

create or replace function public.expire_whatsapp_flow_sessions(
  p_business_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expired integer;
begin
  update public.whatsapp_flow_sessions as session
  set status = 'expired',
      last_activity_at = now(),
      updated_at = now()
  where session.status = 'open'
    and session.expires_at <= now()
    and (p_business_id is null or session.business_id = p_business_id);

  get diagnostics v_expired = row_count;
  return v_expired;
end;
$$;

create or replace function public.get_whatsapp_flow_metrics(
  p_business_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  flow_id uuid,
  flow_key text,
  capability_key text,
  flow_version_id uuid,
  version integer,
  event_type text,
  event_count bigint
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    definition.id,
    definition.flow_key,
    definition.capability_key,
    flow_version.id,
    flow_version.version,
    metric.event_type,
    sum(metric.metric_value)::bigint
  from public.whatsapp_flow_metric_events as metric
  join public.whatsapp_flow_versions as flow_version
    on flow_version.id = metric.flow_version_id
   and flow_version.business_id = metric.business_id
  join public.whatsapp_flow_definitions as definition
    on definition.id = flow_version.flow_id
   and definition.business_id = flow_version.business_id
  where metric.business_id = p_business_id
    and metric.occurred_at >= p_from
    and metric.occurred_at < p_to
  group by
    definition.id,
    definition.flow_key,
    definition.capability_key,
    flow_version.id,
    flow_version.version,
    metric.event_type
  order by definition.flow_key, flow_version.version, metric.event_type;
$$;

-- Métricas automáticas que no dependen del proveedor.
create or replace function public.record_whatsapp_flow_session_metric()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.whatsapp_flow_metric_events (
    business_id,
    provider,
    flow_version_id,
    session_id,
    event_type,
    source_key_hash,
    occurred_at
  ) values (
    new.business_id,
    new.provider,
    new.flow_version_id,
    new.id,
    'session.created',
    encode(digest(convert_to('session.created:' || new.id::text, 'UTF8'), 'sha256'), 'hex'),
    new.created_at
  )
  on conflict (business_id, event_type, source_key_hash) do nothing;
  return new;
end;
$$;

create or replace function public.record_whatsapp_flow_submission_metric()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_flow_version_id uuid;
begin
  select session.flow_version_id
  into v_flow_version_id
  from public.whatsapp_flow_sessions as session
  where session.id = new.session_id
    and session.business_id = new.business_id;

  insert into public.whatsapp_flow_metric_events (
    business_id,
    provider,
    flow_version_id,
    session_id,
    event_type,
    source_key_hash,
    occurred_at
  ) values (
    new.business_id,
    new.provider,
    v_flow_version_id,
    new.session_id,
    'submission.received',
    encode(digest(convert_to('submission.received:' || new.id::text, 'UTF8'), 'sha256'), 'hex'),
    new.created_at
  )
  on conflict (business_id, event_type, source_key_hash) do nothing;
  return new;
end;
$$;

create or replace function public.record_whatsapp_flow_expired_metric()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.status = 'open' and new.status = 'expired' then
    insert into public.whatsapp_flow_metric_events (
      business_id,
      provider,
      flow_version_id,
      session_id,
      event_type,
      source_key_hash,
      occurred_at
    ) values (
      new.business_id,
      new.provider,
      new.flow_version_id,
      new.id,
      'session.expired',
      encode(digest(convert_to('session.expired:' || new.id::text, 'UTF8'), 'sha256'), 'hex'),
      now()
    )
    on conflict (business_id, event_type, source_key_hash) do nothing;
  end if;
  return new;
end;
$$;

create or replace function public.record_whatsapp_flow_processed_metric()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_flow_version_id uuid;
  v_event_type text;
begin
  if old.processing_status = new.processing_status
     or new.processing_status not in ('processed', 'rejected', 'failed') then
    return new;
  end if;

  select session.flow_version_id
  into v_flow_version_id
  from public.whatsapp_flow_sessions as session
  where session.id = new.session_id
    and session.business_id = new.business_id;

  v_event_type := 'submission.' || new.processing_status;
  insert into public.whatsapp_flow_metric_events (
    business_id,
    provider,
    flow_version_id,
    session_id,
    event_type,
    source_key_hash,
    occurred_at
  ) values (
    new.business_id,
    new.provider,
    v_flow_version_id,
    new.session_id,
    v_event_type,
    encode(digest(convert_to(
      v_event_type || ':' || new.id::text,
      'UTF8'
    ), 'sha256'), 'hex'),
    coalesce(new.processed_at, now())
  )
  on conflict (business_id, event_type, source_key_hash) do nothing;
  return new;
end;
$$;

drop trigger if exists whatsapp_flow_session_created_metric
  on public.whatsapp_flow_sessions;
create trigger whatsapp_flow_session_created_metric
after insert on public.whatsapp_flow_sessions
for each row execute function public.record_whatsapp_flow_session_metric();

drop trigger if exists whatsapp_flow_submission_received_metric
  on public.whatsapp_flow_submissions;
create trigger whatsapp_flow_submission_received_metric
after insert on public.whatsapp_flow_submissions
for each row execute function public.record_whatsapp_flow_submission_metric();

drop trigger if exists whatsapp_flow_session_expired_metric
  on public.whatsapp_flow_sessions;
create trigger whatsapp_flow_session_expired_metric
after update of status on public.whatsapp_flow_sessions
for each row execute function public.record_whatsapp_flow_expired_metric();

drop trigger if exists whatsapp_flow_submission_processed_metric
  on public.whatsapp_flow_submissions;
create trigger whatsapp_flow_submission_processed_metric
after update of processing_status on public.whatsapp_flow_submissions
for each row execute function public.record_whatsapp_flow_processed_metric();

-- ── RPC y trigger de despacho retenido ─────────────────────
create or replace function public.ensure_order_delivery_dispatch(
  p_business_id uuid,
  p_order_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_recipient public.delivery_dispatch_recipients%rowtype;
  v_dispatch public.delivery_dispatch_outbox%rowtype;
  v_deduplication_hash text;
begin
  select target.*
  into v_order
  from public.orders as target
  where target.id = p_order_id
    and target.business_id = p_business_id;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'El pedido no pertenece al negocio';
  end if;
  if v_order.status is distinct from 'confirmado'
     or v_order.fulfillment_type is distinct from 'delivery' then
    return jsonb_build_object('result', 'not_eligible', 'dispatch', null);
  end if;

  select recipient.*
  into v_recipient
  from public.delivery_dispatch_recipients as recipient
  where recipient.business_id = p_business_id
    and recipient.active is true
  order by recipient.priority, recipient.created_at, recipient.id
  limit 1;

  v_deduplication_hash := encode(digest(convert_to(
    p_business_id::text || ':order.confirmed:' || p_order_id::text,
    'UTF8'
  ), 'sha256'), 'hex');

  insert into public.delivery_dispatch_outbox (
    business_id,
    order_id,
    recipient_id,
    provider,
    event_type,
    message_template_key,
    status,
    deduplication_key_hash,
    payload
  ) values (
    p_business_id,
    p_order_id,
    v_recipient.id,
    v_recipient.provider,
    'order.confirmed',
    'order_confirmed_driver',
    'held',
    v_deduplication_hash,
    jsonb_build_object(
      'schema_version', 1,
      'event', 'order.confirmed',
      'order_id', p_order_id
    )
  )
  on conflict (business_id, order_id, event_type) do update
  set recipient_id = case
        when public.delivery_dispatch_outbox.status = 'cancelled'
          then excluded.recipient_id
        else coalesce(
          public.delivery_dispatch_outbox.recipient_id,
          excluded.recipient_id
        )
      end,
      provider = case
        when public.delivery_dispatch_outbox.status = 'cancelled'
          then excluded.provider
        else coalesce(
          public.delivery_dispatch_outbox.provider,
          excluded.provider
        )
      end,
      status = case
        when public.delivery_dispatch_outbox.status = 'cancelled'
          then 'held'
        else public.delivery_dispatch_outbox.status
      end,
      attempts = case
        when public.delivery_dispatch_outbox.status = 'cancelled'
          then 0
        else public.delivery_dispatch_outbox.attempts
      end,
      available_at = case
        when public.delivery_dispatch_outbox.status = 'cancelled'
          then now()
        else public.delivery_dispatch_outbox.available_at
      end,
      last_error_code = case
        when public.delivery_dispatch_outbox.status = 'cancelled'
          then null
        else public.delivery_dispatch_outbox.last_error_code
      end,
      released_at = case
        when public.delivery_dispatch_outbox.status = 'cancelled'
          then null
        else public.delivery_dispatch_outbox.released_at
      end,
      cancelled_at = case
        when public.delivery_dispatch_outbox.status = 'cancelled'
          then null
        else public.delivery_dispatch_outbox.cancelled_at
      end,
      updated_at = now()
  returning * into v_dispatch;

  return jsonb_build_object(
    'result',
    v_dispatch.status,
    'dispatch',
    to_jsonb(v_dispatch)
  );
end;
$$;

create or replace function public.assign_delivery_dispatch_recipient(
  p_business_id uuid,
  p_dispatch_id uuid,
  p_recipient_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_recipient public.delivery_dispatch_recipients%rowtype;
  v_dispatch public.delivery_dispatch_outbox%rowtype;
begin
  select recipient.*
  into v_recipient
  from public.delivery_dispatch_recipients as recipient
  where recipient.id = p_recipient_id
    and recipient.business_id = p_business_id
    and recipient.active is true;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'El destinatario no pertenece al negocio';
  end if;

  update public.delivery_dispatch_outbox as dispatch
  set recipient_id = v_recipient.id,
      provider = v_recipient.provider,
      updated_at = now()
  where dispatch.id = p_dispatch_id
    and dispatch.business_id = p_business_id
    and dispatch.status = 'held'
  returning dispatch.* into v_dispatch;

  return case
    when v_dispatch.id is null then null
    else to_jsonb(v_dispatch)
  end;
end;
$$;

create or replace function public.cancel_held_delivery_dispatch(
  p_business_id uuid,
  p_dispatch_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dispatch public.delivery_dispatch_outbox%rowtype;
begin
  if p_business_id is null or p_dispatch_id is null then
    raise exception using
      errcode = '22023',
      message = 'El negocio y el despacho son obligatorios';
  end if;

  update public.delivery_dispatch_outbox as dispatch
  set status = 'cancelled',
      cancelled_at = now(),
      updated_at = now()
  where dispatch.id = p_dispatch_id
    and dispatch.business_id = p_business_id
    and dispatch.status = 'held'
  returning dispatch.* into v_dispatch;

  if found then
    return to_jsonb(v_dispatch);
  end if;

  -- Repetir la misma cancelación es seguro y devuelve el mismo recurso.
  select dispatch.*
  into v_dispatch
  from public.delivery_dispatch_outbox as dispatch
  where dispatch.id = p_dispatch_id
    and dispatch.business_id = p_business_id
    and dispatch.status = 'cancelled';

  return case
    when v_dispatch.id is null then null
    else to_jsonb(v_dispatch)
  end;
end;
$$;

create or replace function public.enqueue_confirmed_delivery_dispatch()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'confirmado'
       and new.fulfillment_type = 'delivery' then
      perform public.ensure_order_delivery_dispatch(new.business_id, new.id);
    end if;
    return new;
  end if;

  if (
    old.status is distinct from new.status
    or old.fulfillment_type is distinct from new.fulfillment_type
  ) and (
    new.status is distinct from 'confirmado'
    or new.fulfillment_type is distinct from 'delivery'
  ) then
    perform public.cancel_held_delivery_dispatch(
      new.business_id,
      dispatch.id
    )
    from public.delivery_dispatch_outbox as dispatch
    where dispatch.business_id = new.business_id
      and dispatch.order_id = new.id
      and dispatch.status = 'held';
  elsif new.status = 'confirmado'
     and new.fulfillment_type = 'delivery'
     and (
       old.status is distinct from new.status
       or old.fulfillment_type is distinct from new.fulfillment_type
     ) then
    perform public.ensure_order_delivery_dispatch(new.business_id, new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists orders_create_held_delivery_dispatch on public.orders;
create trigger orders_create_held_delivery_dispatch
after insert or update of status, fulfillment_type on public.orders
for each row execute function public.enqueue_confirmed_delivery_dispatch();

-- ── Seguridad: backend service_role únicamente ─────────────
alter table public.whatsapp_flow_definitions enable row level security;
alter table public.whatsapp_flow_versions enable row level security;
alter table public.whatsapp_flow_sessions enable row level security;
alter table public.whatsapp_flow_submissions enable row level security;
alter table public.whatsapp_flow_metric_events enable row level security;
alter table public.delivery_dispatch_recipients enable row level security;
alter table public.delivery_dispatch_outbox enable row level security;

revoke all on table
  public.whatsapp_flow_definitions,
  public.whatsapp_flow_versions,
  public.whatsapp_flow_sessions,
  public.whatsapp_flow_submissions,
  public.whatsapp_flow_metric_events,
  public.delivery_dispatch_recipients,
  public.delivery_dispatch_outbox
from public, anon, authenticated, service_role;

grant select, insert, update
  on table public.whatsapp_flow_definitions to service_role;
grant select, update
  on table public.whatsapp_flow_versions to service_role;
grant select, update
  on table public.whatsapp_flow_sessions to service_role;
grant select, update
  on table public.whatsapp_flow_submissions to service_role;
grant select
  on table public.whatsapp_flow_metric_events to service_role;
grant select, insert, update
  on table public.delivery_dispatch_recipients to service_role;
grant select
  on table public.delivery_dispatch_outbox to service_role;

revoke all on function public.create_whatsapp_flow_version(
  uuid, uuid, jsonb, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.activate_whatsapp_flow_version(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.enforce_enabled_whatsapp_flow_definition()
  from public, anon, authenticated;
revoke all on function public.create_whatsapp_flow_session(
  uuid, text, uuid, text, text, timestamptz, jsonb, text
) from public, anon, authenticated;
revoke all on function public.record_whatsapp_flow_submission(
  uuid, text, text, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.resolve_whatsapp_flow_session(text, text)
  from public, anon, authenticated;
revoke all on function public.update_whatsapp_flow_session_context(
  uuid, text, text, integer, jsonb
) from public, anon, authenticated;
revoke all on function public.complete_whatsapp_flow_submission(
  uuid, uuid, text, uuid, text
) from public, anon, authenticated;
revoke all on function public.create_order_from_flow_submission(
  uuid, uuid, text, text, jsonb, text, text, text, text,
  timestamptz, text, numeric, text
) from public, anon, authenticated;
revoke all on function public.record_whatsapp_flow_metric(
  uuid, text, uuid, uuid, text, text, jsonb, timestamptz
) from public, anon, authenticated;
revoke all on function public.expire_whatsapp_flow_sessions(uuid)
  from public, anon, authenticated;
revoke all on function public.get_whatsapp_flow_metrics(
  uuid, timestamptz, timestamptz
) from public, anon, authenticated;
revoke all on function public.ensure_order_delivery_dispatch(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.assign_delivery_dispatch_recipient(
  uuid, uuid, uuid
) from public, anon, authenticated;
revoke all on function public.cancel_held_delivery_dispatch(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.enqueue_confirmed_delivery_dispatch()
  from public, anon, authenticated;
revoke all on function public.record_whatsapp_flow_session_metric()
  from public, anon, authenticated;
revoke all on function public.record_whatsapp_flow_submission_metric()
  from public, anon, authenticated;
revoke all on function public.record_whatsapp_flow_expired_metric()
  from public, anon, authenticated;
revoke all on function public.record_whatsapp_flow_processed_metric()
  from public, anon, authenticated;

grant execute on function public.create_whatsapp_flow_version(
  uuid, uuid, jsonb, text, text, text, text
) to service_role;
grant execute on function public.activate_whatsapp_flow_version(uuid, uuid)
  to service_role;
grant execute on function public.create_whatsapp_flow_session(
  uuid, text, uuid, text, text, timestamptz, jsonb, text
) to service_role;
grant execute on function public.record_whatsapp_flow_submission(
  uuid, text, text, text, text, jsonb
) to service_role;
grant execute on function public.resolve_whatsapp_flow_session(text, text)
  to service_role;
grant execute on function public.update_whatsapp_flow_session_context(
  uuid, text, text, integer, jsonb
) to service_role;
grant execute on function public.complete_whatsapp_flow_submission(
  uuid, uuid, text, uuid, text
) to service_role;
grant execute on function public.create_order_from_flow_submission(
  uuid, uuid, text, text, jsonb, text, text, text, text,
  timestamptz, text, numeric, text
) to service_role;
grant execute on function public.record_whatsapp_flow_metric(
  uuid, text, uuid, uuid, text, text, jsonb, timestamptz
) to service_role;
grant execute on function public.expire_whatsapp_flow_sessions(uuid)
  to service_role;
grant execute on function public.get_whatsapp_flow_metrics(
  uuid, timestamptz, timestamptz
) to service_role;
grant execute on function public.ensure_order_delivery_dispatch(uuid, uuid)
  to service_role;
grant execute on function public.assign_delivery_dispatch_recipient(
  uuid, uuid, uuid
) to service_role;
grant execute on function public.cancel_held_delivery_dispatch(uuid, uuid)
  to service_role;

commit;

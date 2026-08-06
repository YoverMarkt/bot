-- ============================================================
-- BOTPANEL SAAS — Schema COMPLETO y ACTUALIZADO para Supabase
--
-- Refleja el estado REAL de la base de datos (consolidado).
-- SOLO para una base nueva y vacía. NO usar como upgrade de una base existente:
-- los CREATE TABLE IF NOT EXISTS no agregan columnas faltantes y algunas
-- secciones reemplazan funciones/contratos completos.
--
-- INSTRUCCIONES:
--   Supabase → tu proyecto → SQL Editor → New query → pega TODO → RUN
--
-- ⚠️ CÓMO LEER ESTE ARCHIVO — importante, y no es obvio:
--
-- Este archivo es la SUMA de todas las migraciones, en el orden en que se
-- aplicaron. Cada una se copia literalmente (hay guardianes que lo verifican),
-- así que una función puede aparecer definida VARIAS VECES: cada migración que
-- la tocó dejó su versión.
--
-- **Manda siempre la ÚLTIMA definición del archivo**, porque `create or replace`
-- pisa a la anterior. Las de más arriba se aplican y se descartan.
--
-- Si vienes a entender cómo funciona algo, busca la ÚLTIMA aparición:
--
--     grep -n "function public.nombre_de_la_funcion" server/schema.sql
--
-- Hoy le pasa a `create_business_onboarding` (3 veces: la migración inicial, la
-- de hospedaje y la de planes; manda la tercera). Se intentó dejar solo una y
-- se revirtió: borrar las anteriores rompe la garantía de que una instalación
-- nueva acabe igual que una base existente, que es justo lo que evita la deriva.
--
-- Para comprobar que este archivo y la base real coinciden:
--     npm run verify:drift -w @botpanel/server
-- ============================================================

-- Extensión para búsqueda semántica (RAG)
create extension if not exists vector;
-- Operadores GiST usados para impedir reservas solapadas por negocio.
create extension if not exists btree_gist;

-- ── TABLA 1: Negocios (cada cliente del SaaS) ──────────────
create table if not exists businesses (
  id                  uuid primary key default gen_random_uuid(),
  slug                text unique not null,
  name                text not null,
  type                text,
  slogan              text,
  description         text,
  hours               text,
  address             text,
  phone               text,
  social              text,
  payment_methods     text,
  -- WhatsApp personal del dueño: solo este número puede pedir reportes por WhatsApp
  owner_phone         text,
  whatsapp_number     text unique,
  -- Proveedor de mensajería activo: 'ycloud' | 'meta' | 'telegram'
  whatsapp_provider   text default 'ycloud'
                      constraint businesses_whatsapp_provider_check check (
                        nullif(btrim(coalesce(whatsapp_provider, '')), '') is null
                        or btrim(whatsapp_provider) in ('ycloud', 'meta', 'telegram')
                      ),
  -- YCloud
  ycloud_api_key      text,
  ycloud_number       text,
  ycloud_webhook_endpoint_id text
                      constraint businesses_ycloud_webhook_endpoint_id_check check (
                        ycloud_webhook_endpoint_id is null
                        or (
                          ycloud_webhook_endpoint_id = btrim(ycloud_webhook_endpoint_id)
                          and char_length(ycloud_webhook_endpoint_id) between 1 and 255
                          and ycloud_webhook_endpoint_id !~ '[[:cntrl:]]'
                        )
                      ),
  ycloud_webhook_secret text,
  -- Meta
  meta_token          text,
  meta_phone_id       text,
  -- Telegram (token propio del negocio, opcional)
  telegram_bot_token  text,
  -- Integraciones
  calcom_link         text,          -- OBSOLETO (Cal.com retirado); columna huérfana, no se usa
  ai_provider         text,          -- override de IA por negocio (opcional)
  -- Modo de operación: false = solo venta/atención · true = agenda citas (calendario)
  takes_bookings      boolean not null default false,
  -- Modo venta: true = el bot cierra pedidos (##PEDIDO## + total oficial) ·
  -- false = solo informativo (asesora y deriva al asesor si quieren comprar)
  takes_orders        boolean not null default true,
  -- Capacidad independiente para inventario/cotización de hospedaje.
  lodging_enabled     boolean not null default false,
  -- Quién conduce la conversación: 'menu' = máquina de estados por código
  -- (sin IA, opciones de datos reales) · 'ai' = conversación con IA.
  chat_mode           text not null default 'ai'
                      -- 'miniapp' se añadió el 2026-08-02 y vivía SOLO en su
                      -- migración: una base creada desde este archivo no
                      -- admitía el modo. Lo destapó la migración del enlace de
                      -- 24 h, que da de alta un negocio en modo mini app.
                      check (chat_mode in ('menu','ai','miniapp')),
  -- Negocio / facturación
  plan                text default 'basic',
  monthly_rate        numeric(10,2),
  plan_expires_at     timestamptz,
  active              boolean default true,
  bot_active          boolean default true,
  suspended           boolean default false,
  suspension_reason   text,
  notes               text,
  created_at          timestamptz default now()
);

-- ── Identificadores exactos de canales externos ───────────
-- Tabla derivada de businesses. La clave no incluye business_id a propósito:
-- un endpoint exacto dentro del mismo proveedor solo puede tener un dueño.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

create table if not exists public.business_channel_identifiers (
  id                   uuid primary key default gen_random_uuid(),
  business_id          uuid not null
                       references public.businesses(id) on delete cascade,
  provider             text not null
                       check (provider in ('meta', 'ycloud')),
  identifier_type      text not null
                       check (identifier_type in ('phone', 'account_id')),
  canonical_identifier text not null,
  created_at           timestamptz not null default now(),
  constraint business_channel_identifiers_canonical_check check (
    (
      identifier_type = 'phone'
      and canonical_identifier ~ '^[1-9][0-9]{7,14}$'
    )
    or (
      identifier_type = 'account_id'
      and canonical_identifier = btrim(canonical_identifier)
      and char_length(canonical_identifier) between 1 and 255
      and canonical_identifier !~ '[[:cntrl:]]'
    )
  )
);

create unique index if not exists uq_business_channel_identifier
  on public.business_channel_identifiers(
    provider,
    identifier_type,
    canonical_identifier
  );
create unique index if not exists uq_business_channel_phone
  on public.business_channel_identifiers(canonical_identifier)
  where identifier_type = 'phone';
create index if not exists idx_business_channel_identifiers_business
  on public.business_channel_identifiers(business_id);

alter table public.business_channel_identifiers enable row level security;
revoke all on table public.business_channel_identifiers
  from public, anon, authenticated, service_role;
grant select on table public.business_channel_identifiers to service_role;

create or replace function public.normalize_business_channel_identifier(
  p_identifier_type text,
  p_value text
)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_value text := btrim(p_value);
  v_canonical text;
begin
  if v_value = '' then return null; end if;

  if p_identifier_type = 'phone' then
    if v_value !~ '^\+?[0-9 ().-]+$' then
      raise exception using
        errcode = '22023',
        message = 'El teléfono del canal contiene caracteres inválidos';
    end if;
    v_canonical := regexp_replace(v_value, '[+ ().-]', '', 'g');
    if v_canonical !~ '^[1-9][0-9]{7,14}$' then
      raise exception using
        errcode = '22023',
        message = 'El teléfono del canal debe usar formato E.164 con 8 a 15 dígitos';
    end if;
    return v_canonical;
  end if;

  if p_identifier_type = 'account_id' then
    if char_length(v_value) > 255 or v_value ~ '[[:cntrl:]]' then
      raise exception using
        errcode = '22023',
        message = 'El identificador de cuenta del canal es inválido';
    end if;
    return v_value;
  end if;

  raise exception using
    errcode = '22023',
    message = 'El tipo de identificador del canal es inválido';
end;
$$;

create or replace function public.refresh_business_channel_identifiers(
  p_business_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business public.businesses%rowtype;
  v_candidate record;
  v_existing_business_id uuid;
  v_phone_owner_business_id uuid;
  v_whatsapp_provider text;
  v_whatsapp_phone text;
  v_ycloud_phone text;
  v_meta_account_id text;
begin
  select * into v_business
  from public.businesses
  where id = p_business_id;

  if not found then
    delete from public.business_channel_identifiers
    where business_id = p_business_id;
    return;
  end if;

  v_whatsapp_provider := coalesce(
    nullif(btrim(coalesce(v_business.whatsapp_provider, '')), ''),
    'ycloud'
  );
  if v_whatsapp_provider not in ('meta', 'ycloud', 'telegram') then
    raise exception using
      errcode = '22023',
      message = 'El proveedor WhatsApp configurado es inválido',
      detail = format(
        'business_id=%s provider=%s', p_business_id, v_whatsapp_provider
      );
  end if;

  if v_whatsapp_provider in ('meta', 'ycloud') then
    v_whatsapp_phone := public.normalize_business_channel_identifier(
      'phone', v_business.whatsapp_number
    );
  end if;
  if v_whatsapp_provider = 'ycloud' then
    v_ycloud_phone := public.normalize_business_channel_identifier(
      'phone', v_business.ycloud_number
    );
  end if;
  if v_whatsapp_provider = 'meta' then
    v_meta_account_id := public.normalize_business_channel_identifier(
      'account_id', v_business.meta_phone_id
    );
  end if;
  if v_whatsapp_provider = 'ycloud'
    and coalesce(v_ycloud_phone, v_whatsapp_phone) is null then
    raise exception using
      errcode = '22023',
      message = 'YCloud requiere un teléfono de canal válido',
      detail = format('business_id=%s provider=ycloud', p_business_id);
  elsif v_whatsapp_provider = 'meta'
    and v_meta_account_id is null then
    raise exception using
      errcode = '22023',
      message = 'Meta requiere un Phone ID válido',
      detail = format('business_id=%s provider=meta', p_business_id);
  end if;

  delete from public.business_channel_identifiers
  where business_id = p_business_id;

  for v_candidate in
    select distinct
      candidates.provider,
      candidates.identifier_type,
      candidates.canonical_identifier
    from (
      select
        v_whatsapp_provider as provider,
        'phone'::text as identifier_type,
        v_whatsapp_phone as canonical_identifier
      where v_whatsapp_provider in ('meta', 'ycloud')

      union all

      select
        'ycloud',
        'phone',
        v_ycloud_phone
      where v_whatsapp_provider = 'ycloud'

      union all

      select
        'meta',
        'account_id',
        v_meta_account_id
      where v_whatsapp_provider = 'meta'
    ) as candidates
    where candidates.canonical_identifier is not null
    order by
      candidates.identifier_type,
      candidates.canonical_identifier,
      candidates.provider
  loop
    if v_candidate.identifier_type = 'phone' then
      perform pg_advisory_xact_lock(hashtextextended(
        'business-channel-phone:' || v_candidate.canonical_identifier,
        0
      ));
      v_phone_owner_business_id := null;
      select business_id into v_phone_owner_business_id
      from public.business_channel_identifiers
      where identifier_type = 'phone'
        and canonical_identifier = v_candidate.canonical_identifier
        and business_id <> p_business_id
      limit 1;

      if v_phone_owner_business_id is not null then
        raise exception using
          errcode = '23505',
          message = 'Un teléfono de canal ya pertenece a otro negocio',
          detail = format(
            'identifier=%s existing_business_id=%s requested_business_id=%s',
            v_candidate.canonical_identifier,
            v_phone_owner_business_id,
            p_business_id
          );
      end if;
    end if;

    v_existing_business_id := null;
    select business_id into v_existing_business_id
    from public.business_channel_identifiers
    where provider = v_candidate.provider
      and identifier_type = v_candidate.identifier_type
      and canonical_identifier = v_candidate.canonical_identifier;

    if v_existing_business_id is not null
      and v_existing_business_id <> p_business_id then
      raise exception using
        errcode = '23505',
        message = 'Un identificador de canal ya pertenece a otro negocio',
        detail = format(
          'provider=%s type=%s identifier=%s existing_business_id=%s requested_business_id=%s',
          v_candidate.provider,
          v_candidate.identifier_type,
          v_candidate.canonical_identifier,
          v_existing_business_id,
          p_business_id
        );
    end if;

    if v_existing_business_id is null then
      insert into public.business_channel_identifiers (
        business_id,
        provider,
        identifier_type,
        canonical_identifier
      ) values (
        p_business_id,
        v_candidate.provider,
        v_candidate.identifier_type,
        v_candidate.canonical_identifier
      );
    end if;
  end loop;
end;
$$;

create or replace function public.sync_business_channel_identifiers()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.refresh_business_channel_identifiers(new.id);
  return new;
end;
$$;

revoke all on function public.normalize_business_channel_identifier(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.refresh_business_channel_identifiers(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.sync_business_channel_identifiers()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_sync_business_channel_identifiers
  on public.businesses;
create trigger trg_sync_business_channel_identifiers
after insert or update of
  whatsapp_number,
  whatsapp_provider,
  ycloud_number,
  meta_phone_id
on public.businesses
for each row
execute function public.sync_business_channel_identifiers();

lock table public.businesses in share row exclusive mode;

do $$
declare
  v_business_id uuid;
begin
  for v_business_id in
    select id from public.businesses order by id
  loop
    perform public.refresh_business_channel_identifiers(v_business_id);
  end loop;
end;
$$;

commit;

-- ============================================================
-- MEDICIÓN DE CONSUMO MENSUAL POR NEGOCIO
-- Migración incremental: migration-consumo-planes.sql
-- ============================================================

begin;

create extension if not exists pgcrypto;

create table if not exists public.message_usage_migration_state (
  key          text primary key,
  completed_at timestamptz not null default now()
);

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

alter table public.businesses
  add column if not exists monthly_contact_limit integer,
  add column if not exists monthly_outbound_message_limit integer;

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
    select 1 from pg_constraint
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
    select 1 from pg_constraint
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

-- El esquema consolidado se ejecuta sobre una base vacía: no hay historial
-- anterior que reconstruir. El marcador evita un backfill accidental futuro.
insert into public.message_usage_migration_state (key)
values ('conversation_history_v1')
on conflict (key) do nothing;

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
    business_id, provider, direction, message_type, contact_key_hash,
    source_kind, source_key, occurred_at
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
    business.id,
    period_window.starts_on,
    period_window.ends_before - 1,
    count(distinct usage.contact_key_hash)
      filter (where usage.direction = 'inbound'),
    count(usage.id) filter (where usage.direction = 'inbound'),
    count(usage.id) filter (where usage.direction = 'outbound'),
    count(usage.id) filter (
      where usage.direction = 'outbound' and usage.message_type = 'text'
    ),
    count(usage.id) filter (
      where usage.direction = 'outbound' and usage.message_type = 'image'
    ),
    count(usage.id) filter (
      where usage.direction = 'outbound' and usage.message_type = 'video'
    ),
    count(usage.id) filter (
      where usage.direction = 'outbound'
        and usage.message_type = 'interactive'
    ),
    business.monthly_contact_limit,
    business.monthly_outbound_message_limit,
    case
      when business.monthly_contact_limit is null then 0
      else greatest(
        count(distinct usage.contact_key_hash)
          filter (where usage.direction = 'inbound')
          - business.monthly_contact_limit,
        0
      )
    end,
    case
      when business.monthly_outbound_message_limit is null then 0
      else greatest(
        count(usage.id) filter (where usage.direction = 'outbound')
          - business.monthly_outbound_message_limit,
        0
      )
    end,
    coalesce(
      bool_or(usage.source_kind = 'history')
        filter (where usage.id is not null),
      false
    )
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
grant select, insert on table public.message_usage_events to service_role;
revoke all on table public.message_usage_migration_state
  from public, anon, authenticated;

revoke all on function public.record_inbound_message_usage()
  from public, anon, authenticated;
revoke all on function public.get_admin_monthly_usage(date)
  from public, anon, authenticated;
grant execute on function public.get_admin_monthly_usage(date)
  to service_role;

commit;

-- ── TABLA 2: Usuarios del panel del cliente (dueño + empleados) ─
create table if not exists client_users (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  email         text unique not null,
  password_hash text not null,
  name          text,
  role          text not null default 'owner',   -- 'owner' | 'employee'
  permissions   jsonb default '[]',              -- secciones permitidas al empleado
  created_at    timestamptz default now()
);

-- ── TABLA 3: Productos / servicios de cada negocio ─────────
create table if not exists products (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  name            text not null,
  brand           text,
  price           numeric(10,2) not null,
  price_sale      numeric(10,2),
  stock           text default 'disponible'
                  check (stock in ('disponible','últimas unidades','agotado')),
  description     text,
  image_url       text,
  video_url       text,                 -- URL pública del video (Cloudinary)
  image_public_id text,                 -- id del archivo de imagen en Cloudinary (para borrarlo al reemplazar)
  video_public_id text,                 -- id del archivo de video en Cloudinary
  tags            text[] default '{}',
  external_sku    text,
  duration_minutes int,                 -- para negocios de servicios/citas
  embedding       vector(1536),         -- RAG (OpenAI text-embedding-3-small)
  active          boolean default true,
  updated_at      timestamptz default now(),
  created_at      timestamptz default now()
);

-- ── Modificadores de menú (sabores de pizza, salsas, extras) ──
-- Opción que el cliente elige ADEMÁS del producto sin cambiar el precio.
-- Agrupados por category_tag (la categoría del catálogo a la que aplican).
create table if not exists public.menu_modifiers (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  category_tag  text not null check (char_length(btrim(category_tag)) between 1 and 60),
  group_label   text not null default 'Opción' check (char_length(btrim(group_label)) between 1 and 60),
  name          text not null check (char_length(btrim(name)) between 1 and 120),
  description   text,
  sort          integer not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_menu_modifiers_business_tag
  on public.menu_modifiers (business_id, category_tag);
create unique index if not exists uq_menu_modifiers_business_tag_name
  on public.menu_modifiers (business_id, category_tag, lower(name));

-- ── TABLA 4: Políticas + prompt del bot por negocio ────────
create table if not exists bot_policies (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references businesses(id) on delete cascade unique,
  bot_prompt        text,               -- personalidad/prompt del bot
  shipping          text,
  returns           text,
  discounts         text,
  bot_instructions  text,
  updated_at        timestamptz default now()
);

-- ── TABLA 5: Historial de conversaciones ───────────────────
create table if not exists conversation_history (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  contact_phone   text not null,
  role            text check (role in ('user','assistant','owner')),
  content         text not null,
  created_at      timestamptz default now()
);

-- ── TABLA 6: Sesiones (modo manual / traspaso a humano) ────
create table if not exists conversation_sessions (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  contact_phone   text not null,
  contact_name    text,
  manual_mode     boolean default false,
  unread_owner    boolean default false,
  last_message    text,
  last_message_at timestamptz default now(),
  closed_sale_at  timestamptz,                 -- corte de historial al cerrar una venta
  tags            jsonb default '[]'::jsonb,   -- ids de conversation_tags asignadas
  unique (business_id, contact_phone)
);

-- Etiquetas de conversación (el dueño crea las suyas): nombre + color
create table if not exists conversation_tags (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name        text not null,
  color       text default '#2a78d6',
  created_at  timestamptz default now()
);
create index if not exists idx_conv_tags_biz on conversation_tags(business_id);

-- ── TABLA 7: Horarios de atención (para reservas) ──────────
create table if not exists business_schedule (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  day_of_week   int not null,           -- 0=Domingo … 6=Sábado
  open_time     time not null default '09:00',
  close_time    time not null default '18:00',
  slot_duration int not null default 60,
  is_active     boolean default true,
  unique (business_id, day_of_week)
);

-- Toda empresa nace con un horario editable. El trigger también cubre altas
-- realizadas fuera del panel, evitando negocios sin configuración mínima.
create or replace function public.ensure_business_default_schedule()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.business_schedule (
    business_id, day_of_week, open_time, close_time, slot_duration, is_active
  ) values
    (new.id, 0, '09:00', '18:00', 60, false),
    (new.id, 1, '09:00', '18:00', 60, true),
    (new.id, 2, '09:00', '18:00', 60, true),
    (new.id, 3, '09:00', '18:00', 60, true),
    (new.id, 4, '09:00', '18:00', 60, true),
    (new.id, 5, '09:00', '18:00', 60, true),
    (new.id, 6, '09:00', '13:00', 60, true)
  on conflict (business_id, day_of_week) do nothing;
  return new;
end;
$$;

revoke all on function public.ensure_business_default_schedule()
  from public, anon, authenticated;

drop trigger if exists businesses_default_schedule on public.businesses;
create trigger businesses_default_schedule
after insert on public.businesses
for each row execute function public.ensure_business_default_schedule();

-- ── TABLA 8: Reservas / citas ──────────────────────────────
create table if not exists bookings (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  contact_phone   text not null,
  contact_name    text,
  service         text,
  booking_date    date not null,
  booking_time    time not null,
  duration_minutes int not null default 60
                   check (duration_minutes between 1 and 1440),
  notes           text,
  status          text not null default 'pending'
                  check (status in ('pending','confirmed','cancelled','no_show')),
  created_at      timestamptz default now()
);

-- ── TABLA 9: Facturación ───────────────────────────────────
create table if not exists billing (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  amount        numeric(10,2),
  currency      text default 'USD',
  period_start  date,
  period_end    date,
  status        text default 'pending'
                check (status in ('pending','paid','overdue')),
  paid_at       timestamptz,
  notes         text,
  created_at    timestamptz default now()
);

-- ── TABLA 10: Config global del SaaS (keys de IA, etc.) ────
-- NO es por negocio: es configuración del dueño del SaaS.
create table if not exists server_settings (
  key         text primary key,
  value       text,
  updated_at  timestamptz default now()
);

-- ── Registro de migraciones aplicadas ──────────────────────
-- NO es por negocio: es el libro de cuentas de la plataforma. Dice qué .sql
-- se aplicó y cuándo, y guarda su huella para que editar una migración ya
-- aplicada no pase inadvertido. Lo lleva `npm run migrate -w @botpanel/server`.
create table if not exists schema_migrations (
  name        text primary key,
  checksum    text not null,
  applied_at  timestamptz not null default now(),
  source      text not null default 'runner'
);
create index if not exists idx_schema_migrations_applied
  on schema_migrations(applied_at desc);

-- ── TABLA 11: Ventas (cabecera) — registro manual desde el panel ──
create table if not exists sales (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  contact_phone text,
  contact_name  text,
  total         numeric(10,2) not null default 0,
  status        text not null default 'completada' check (status in ('completada','anulada')),
  source        text default 'manual',
  created_by    uuid references client_users(id) on delete set null,  -- vendedor que la registró
  sold_at       timestamptz default now(),
  created_at    timestamptz default now()
);

-- ── TABLA 12: Ítems de cada venta (detalle, alimenta reportes) ──
create table if not exists sale_items (
  id           uuid primary key default gen_random_uuid(),
  sale_id      uuid references sales(id)      on delete cascade,
  business_id  uuid not null references businesses(id) on delete cascade,
  product_id   uuid references products(id)   on delete set null,
  product_name text not null,
  quantity     int not null default 1,
  unit_price   numeric(10,2) not null default 0,
  line_total   numeric(10,2) not null default 0,
  created_at   timestamptz default now()
);

-- ── TABLA 13: Consultas de productos (más consultados / abandonados) ──
create table if not exists product_consultations (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  product_id   uuid references products(id)   on delete cascade,
  created_at   timestamptz default now()
);

-- ── TABLA 14: Huecos de IA (preguntas que el bot no pudo responder) ──
create table if not exists ai_gaps (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  contact_phone text,            -- quién preguntó (contexto, opcional)
  question      text not null,   -- la pregunta que el bot no supo responder
  reason        text,            -- 'handoff' | 'uncertain'
  created_at    timestamptz default now()
);

-- ── TABLA 15: Pedidos del bot (total oficial calculado por CÓDIGO) ──
-- El bot emite ##PEDIDO:producto x cantidad##; el servidor resuelve productos,
-- calcula el total server-side (la IA nunca decide montos) y envía el resumen.
create table if not exists orders (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references businesses(id) on delete cascade,
  contact_phone    text not null,
  contact_name     text,
  -- Flujo hacia adelante: pendiente → confirmado → preparacion → en_camino →
  -- completado (o cancelado desde cualquiera). Lo hace cumplir set_order_status.
  status           text not null default 'pendiente'
                   constraint orders_status_check check (status in (
                     'pendiente','esperando_pago','pago_en_revision','confirmado',
                     'aceptado','preparacion','listo_para_retiro','en_camino',
                     'completado','cancelado','rechazado','expirado'
                   )),
  subtotal         numeric(10,2) not null default 0,
  discount         numeric(10,2) not null default 0,  -- solo por código/panel, jamás la IA
  total            numeric(10,2) not null default 0,
  currency         text not null default 'USD',
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- ── El mismo pedido dos veces es UN pedido ──────────────────────────────
-- Un doble toque en «Confirmar», o la app reintentando tras un corte de red,
-- creaban dos comandas en la cocina y un cliente pagando dos veces. La app
-- manda una clave por intento de compra
-- (migration-2026-08-05-pedidos-sin-duplicados.sql).
alter table public.orders
  add column if not exists idempotency_key text;
alter table public.orders
  add column if not exists scheduled_for timestamptz;

-- Único POR NEGOCIO y solo cuando hay clave: los pedidos del bot no la traen y
-- no pueden chocar entre sí por ser todos nulos.
create unique index if not exists uq_orders_idempotencia
  on public.orders (business_id, idempotency_key)
  where idempotency_key is not null;

-- El pedido como destino de foránea compuesta: sin el business_id dentro se
-- podría colgar el historial de un negocio sobre el pedido de otro.
create unique index if not exists uq_orders_id_business
  on public.orders (id, business_id);

-- ── El historial de estados ─────────────────────────────────────────────
-- Sin esto, «¿cuándo se confirmó?» solo se responde mirando `updated_at`, que
-- se pisa con cada cambio.
create table if not exists public.order_events (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  order_id    uuid not null,
  from_status text,
  to_status   text not null,
  note        text,
  created_at  timestamptz not null default now(),
  constraint order_events_datos_check check (
    char_length(btrim(to_status)) between 1 and 40
    and char_length(coalesce(note, '')) <= 300
  )
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_events'::regclass
      and conname = 'fk_order_events_pedido_del_negocio'
  ) then
    alter table public.order_events
      add constraint fk_order_events_pedido_del_negocio
      foreign key (order_id, business_id)
      references public.orders (id, business_id) on delete cascade;
  end if;
end $$;

create index if not exists idx_order_events_pedido
  on public.order_events (business_id, order_id, created_at);

alter table public.order_events enable row level security;
revoke all on table public.order_events from public, anon, authenticated;
grant select, insert, update, delete on table public.order_events to service_role;

-- ── TABLA 16: Ítems del pedido (precio congelado al momento del pedido) ──
create table if not exists order_items (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid references orders(id)     on delete cascade,
  business_id  uuid not null references businesses(id) on delete cascade,
  product_id   uuid references products(id)   on delete set null,
  product_name text not null,
  quantity     int not null default 1 check (quantity > 0),
  unit_price   numeric(10,2) not null default 0,
  line_total   numeric(10,2) not null default 0,
  created_at   timestamptz default now()
);

-- ── TABLA 17: Inbox durable de webhooks ───────────────────
-- Conserva el payload normalizado solo mientras esta pendiente, en proceso o
-- dead. Al completar se elimina inmediatamente y queda unicamente el hash para
-- deduplicar redeliveries durante 24 horas.
create table if not exists webhook_inbound_events (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  provider        text not null check (provider in ('meta', 'ycloud')),
  message_id_hash text not null check (message_id_hash ~ '^[0-9a-f]{64}$'),
  payload_version smallint not null default 1,
  payload          jsonb,
  stream_key_hash  text,
  status            text not null default 'completed'
                    check (status in ('pending','processing','completed','dead')),
  attempts          integer not null default 0,
  max_attempts      integer not null default 8,
  available_at      timestamptz not null default now(),
  lease_token       uuid,
  lease_owner       text,
  leased_until      timestamptz,
  last_error        text,
  completed_at      timestamptz,
  dead_at           timestamptz,
  received_at       timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint webhook_inbound_events_attempts_check check (
    attempts between 0 and max_attempts and max_attempts between 1 and 100
  ),
  constraint webhook_inbound_events_payload_check check (
    (status = 'completed' and payload is null)
    or (
      status in ('pending','processing','dead')
      and payload is not null
      and jsonb_typeof(payload) = 'object'
      and pg_column_size(payload) <= 262144
      and stream_key_hash is not null
      and stream_key_hash ~ '^[0-9a-f]{64}$'
    )
  ),
  constraint webhook_inbound_events_lease_check check (
    (
      status = 'processing'
      and lease_token is not null
      and leased_until is not null
      and nullif(btrim(lease_owner), '') is not null
      and char_length(lease_owner) <= 128
    )
    or (
      status <> 'processing'
      and lease_token is null
      and leased_until is null
      and lease_owner is null
    )
  )
);

drop trigger if exists webhook_inbound_message_usage
  on public.webhook_inbound_events;
create trigger webhook_inbound_message_usage
after insert on public.webhook_inbound_events
for each row execute function public.record_inbound_message_usage();

-- ── TABLA 18: Registro de errores de plataforma ────────────
-- Agrupa por huella: mil repeticiones del mismo fallo son UNA fila con
-- occurrences = 1000. `business_id` admite NULL para errores que no pertenecen
-- a ningún negocio (arranque, webhook sin resolver). Ver
-- migration-registro-errores.sql para las funciones que la operan.
create table if not exists public.platform_errors (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references public.businesses(id) on delete cascade,
  category      text not null check (category in ('canal', 'ia', 'envio', 'servidor')),
  code          text,
  message       text not null,
  context       jsonb not null default '{}'::jsonb,
  fingerprint   text not null,
  occurrences   integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  constraint platform_errors_tamanos_check check (
    char_length(message) between 1 and 2000
    and char_length(coalesce(code, '')) <= 120
    and fingerprint ~ '^[0-9a-f]{64}$'
    and occurrences >= 1
    and pg_column_size(context) <= 8192
  )
);

-- ── ÍNDICES ────────────────────────────────────────────────
create index if not exists idx_platform_errors_recientes
  on public.platform_errors (last_seen_at desc);
create index if not exists idx_platform_errors_negocio
  on public.platform_errors (business_id, last_seen_at desc);
-- Dos índices parciales porque en SQL NULL nunca es igual a NULL: los errores
-- sin negocio se agrupan aparte.
create unique index if not exists uq_platform_errors_negocio_huella
  on public.platform_errors (business_id, fingerprint)
  where business_id is not null;
create unique index if not exists uq_platform_errors_huella_global
  on public.platform_errors (fingerprint)
  where business_id is null;

create index if not exists idx_products_biz      on products(business_id);
create index if not exists idx_history_contact   on conversation_history(business_id, contact_phone);
create index if not exists idx_history_date      on conversation_history(business_id, created_at);
create index if not exists idx_sessions_biz      on conversation_sessions(business_id);
create index if not exists idx_schedule_biz      on business_schedule(business_id);
create index if not exists idx_bookings_biz      on bookings(business_id);
create index if not exists idx_bookings_date     on bookings(business_id, booking_date);
create index if not exists idx_biz_phone         on businesses(whatsapp_number);
create index if not exists idx_billing_biz       on billing(business_id);
create index if not exists idx_sales_biz          on sales(business_id);
create index if not exists idx_sales_biz_date     on sales(business_id, sold_at);
create index if not exists idx_sales_biz_phone    on sales(business_id, contact_phone);
create index if not exists idx_sale_items_sale    on sale_items(sale_id);
create index if not exists idx_sale_items_biz_prod on sale_items(business_id, product_id);
create index if not exists idx_pconsult_biz_date   on product_consultations(business_id, created_at);
create index if not exists idx_pconsult_biz_prod   on product_consultations(business_id, product_id);
create index if not exists idx_ai_gaps_biz_date    on ai_gaps(business_id, created_at);
create index if not exists idx_orders_biz          on orders(business_id);
create index if not exists idx_orders_biz_phone    on orders(business_id, contact_phone);
create index if not exists idx_orders_biz_date     on orders(business_id, created_at);
create index if not exists idx_order_items_order   on order_items(order_id);
create index if not exists idx_order_items_biz     on order_items(business_id);
create unique index if not exists uq_webhook_events_business_provider_hash
  on webhook_inbound_events(business_id, provider, message_id_hash);
create index if not exists idx_webhook_events_business_received
  on webhook_inbound_events(business_id, received_at);
create index if not exists idx_webhook_events_received
  on webhook_inbound_events(received_at);
create index if not exists idx_webhook_inbox_ready
  on webhook_inbound_events(available_at, received_at, id)
  where status = 'pending';
create index if not exists idx_webhook_inbox_expired_leases
  on webhook_inbound_events(leased_until)
  where status = 'processing';
create index if not exists idx_webhook_inbox_stream_order
  on webhook_inbound_events(
    business_id, provider, stream_key_hash, received_at, id
  )
  where status in ('pending', 'processing');
create unique index if not exists uq_webhook_inbox_processing_stream
  on webhook_inbound_events(business_id, provider, stream_key_hash)
  where status = 'processing';

-- Normalización compatible con instalaciones creadas antes de que la duración
-- y el tenant de las reservas fueran obligatorios.
update public.bookings as booking
set duration_minutes = coalesce(
  (
    select schedule.slot_duration
    from public.business_schedule as schedule
    where schedule.business_id = booking.business_id
      and schedule.day_of_week = extract(dow from booking.booking_date)::integer
    limit 1
  ),
  60
)
where booking.duration_minutes is null
   or booking.duration_minutes <= 0;

update public.bookings set status = 'pending' where status is null;

do $$
begin
  if exists (select 1 from public.bookings where business_id is null) then
    raise exception using
      errcode = '23502',
      message = 'Existen reservas sin negocio. Asígnales un business_id válido antes de continuar.';
  end if;
  if exists (select 1 from public.bookings where duration_minutes > 1440) then
    raise exception using
      errcode = '23514',
      message = 'Existen reservas con duración mayor a 1440 minutos. Corrígelas antes de continuar.';
  end if;
end;
$$;

alter table public.bookings
  alter column business_id set not null,
  alter column duration_minutes set default 60,
  alter column duration_minutes set not null,
  alter column status set default 'pending',
  alter column status set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bookings'::regclass
      and conname = 'bookings_duration_minutes_check'
  ) then
    alter table public.bookings
      add constraint bookings_duration_minutes_check
      check (duration_minutes between 1 and 1440) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bookings'::regclass
      and conname = 'bookings_no_active_overlap'
  ) then
    alter table public.bookings
      add constraint bookings_no_active_overlap
      exclude using gist (
        business_id with =,
        tsrange(
          booking_date + booking_time,
          booking_date + booking_time
            + make_interval(mins => duration_minutes),
          '[)'
        ) with &&
      )
      where (status in ('pending', 'confirmed'));
  end if;
end;
$$;

alter table public.bookings
  validate constraint bookings_duration_minutes_check;

-- ── FUNCIÓN RAG: búsqueda de productos por significado ─────
create or replace function match_products(query_embedding vector(1536), biz_id uuid, match_count int)
returns table (
  id uuid, name text, brand text, price numeric, price_sale numeric,
  stock text, description text, tags text[], image_url text, duration_minutes int, similarity float
)
language sql stable as $$
  select p.id, p.name, p.brand, p.price, p.price_sale, p.stock,
         p.description, p.tags, p.image_url, p.duration_minutes,
         1 - (p.embedding <=> query_embedding) as similarity
  from products p
  where p.business_id = biz_id and p.active = true and p.embedding is not null
  order by p.embedding <=> query_embedding
  limit match_count;
$$;

-- ── FUNCIÓN ATÓMICA: pedido del bot + detalles ─────────────
-- La firma cambió al añadir el origen: dejar viva la anterior haría ambigua
-- cualquier llamada.
drop function if exists public.create_order_with_items(
  uuid, text, text, text, numeric, text, jsonb
);

create or replace function public.create_order_with_items(
  p_business_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_status text,
  p_discount numeric,
  p_currency text,
  p_items jsonb,
  p_source text default 'whatsapp'
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_order orders%rowtype;
  v_item jsonb;
  v_normalized_items jsonb := '[]'::jsonb;
  v_product_id uuid;
  v_product_name text;
  v_product_stock text;
  v_quantity integer;
  v_requested_price numeric(10,2);
  v_unit_price numeric(10,2);
  v_line_total numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_discount numeric(10,2) := round(coalesce(p_discount, 0), 2);
  v_total numeric(10,2);
begin
  if p_business_id is null then
    raise exception using errcode = '22023', message = 'El negocio es obligatorio';
  end if;
  if nullif(btrim(p_contact_phone), '') is null then
    raise exception using errcode = '22023', message = 'El contacto es obligatorio';
  end if;
  if coalesce(p_status, 'pendiente') not in (
    'pendiente', 'confirmado', 'completado', 'cancelado', 'expirado'
  ) then
    raise exception using errcode = '22023', message = 'Estado de pedido inválido';
  end if;
  if coalesce(p_source, 'whatsapp') not in ('whatsapp', 'storefront', 'marketplace', 'manual') then
    raise exception using errcode = '22023', message = 'Origen de pedido inválido';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'El pedido necesita al menos un ítem';
  end if;
  if v_discount < 0 then
    raise exception using errcode = '22023', message = 'El descuento no puede ser negativo';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Cada ítem debe ser un objeto';
    end if;
    v_product_id := nullif(v_item ->> 'product_id', '')::uuid;
    v_quantity := (v_item ->> 'quantity')::integer;
    v_requested_price := round((v_item ->> 'unit_price')::numeric, 2);
    if v_product_id is null then
      raise exception using errcode = '22023', message = 'El producto es obligatorio';
    end if;
    if v_quantity < 1 or v_quantity > 99 then
      raise exception using errcode = '22023', message = 'La cantidad debe estar entre 1 y 99';
    end if;
    select
      p.name,
      round(case when p.price_sale > 0 then p.price_sale else p.price end, 2),
      p.stock
    into v_product_name, v_unit_price, v_product_stock
    from products p
    where p.id = v_product_id
      and p.business_id = p_business_id
      and p.active = true
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'El producto no pertenece al negocio';
    end if;
    if v_product_stock = 'agotado' then
      raise exception using errcode = '22023', message = 'El producto está agotado';
    end if;
    if not (v_unit_price > 0) then
      raise exception using errcode = '22023', message = 'El producto no tiene un precio válido';
    end if;
    -- El precio que manda quien llama es una OPINIÓN que hay que confirmar,
    -- no un dato que se acepte: si no coincide con el catálogo, el pedido se
    -- rehace. Así el bot no puede cobrar un precio que ya cambió mientras el
    -- cliente decidía.
    --
    -- Pero ausente NO es lo mismo que distinto: significa «no tengo opinión,
    -- usa tu catálogo». Sin esta distinción, `null is distinct from 2.75` daba
    -- cierto y el pedido de MOSTRADOR —que a propósito manda solo ids y
    -- cantidades— fallaba SIEMPRE con 40001. Nunca funcionó desde que se
    -- publicó (2026-08-02), y ninguna prueba lo veía porque todas mandaban
    -- precio. El precio sigue saliendo solo del catálogo en los dos casos.
    if v_requested_price is not null and v_requested_price is distinct from v_unit_price then
      raise exception using errcode = '40001', message = 'El precio cambió; vuelve a calcular el pedido';
    end if;
    v_line_total := round(v_quantity * v_unit_price, 2);
    v_subtotal := v_subtotal + v_line_total;
    v_normalized_items := v_normalized_items || jsonb_build_array(jsonb_build_object(
      'product_id', v_product_id, 'product_name', v_product_name,
      'quantity', v_quantity, 'unit_price', v_unit_price, 'line_total', v_line_total
    ));
  end loop;

  v_subtotal := round(v_subtotal, 2);
  if v_discount > v_subtotal then
    raise exception using errcode = '22023', message = 'El descuento supera el subtotal';
  end if;
  v_total := round(v_subtotal - v_discount, 2);

  insert into orders (
    business_id, contact_phone, contact_name, status,
    subtotal, discount, total, currency, source
  ) values (
    p_business_id, btrim(p_contact_phone), nullif(btrim(p_contact_name), ''),
    coalesce(p_status, 'pendiente'), v_subtotal, v_discount, v_total,
    coalesce(nullif(btrim(p_currency), ''), 'USD'), coalesce(p_source, 'whatsapp')
  ) returning * into v_order;

  insert into order_items (
    order_id, business_id, product_id, product_name, quantity, unit_price, line_total
  )
  select
    v_order.id, p_business_id, nullif(item ->> 'product_id', '')::uuid,
    item ->> 'product_name', (item ->> 'quantity')::integer,
    (item ->> 'unit_price')::numeric, (item ->> 'line_total')::numeric
  from jsonb_array_elements(v_normalized_items) as item;

  -- Nace entregado (mostrador): la venta se crea aquí, no en una segunda
  -- llamada desde Node que podría no ocurrir si algo falla entre medias.
  if coalesce(p_status, 'pendiente') = 'completado' then
    perform public.crear_venta_desde_pedido(p_business_id, v_order.id);
  end if;

  return to_jsonb(v_order);
end;
$$;

revoke all on function public.create_order_with_items(uuid, text, text, text, numeric, text, jsonb, text) from public;
revoke all on function public.create_order_with_items(uuid, text, text, text, numeric, text, jsonb, text) from anon;
revoke all on function public.create_order_with_items(uuid, text, text, text, numeric, text, jsonb, text) from authenticated;
grant execute on function public.create_order_with_items(uuid, text, text, text, numeric, text, jsonb, text) to service_role;

-- Cambia el ciclo de vida de un pedido de forma atómica. Los estados finales
-- no pueden reabrirse y repetir el mismo cambio es seguro.
-- ── PEDIDO ENTREGADO → VENTA ───────────────────────────────
-- Vive aparte para que la usen los dos caminos que cierran un pedido: marcarlo
-- entregado desde la bandeja, y el pedido de mostrador que nace ya entregado.
create or replace function public.crear_venta_desde_pedido(
  p_business_id uuid,
  p_order_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_sale_id uuid;
begin
  select * into v_order
  from public.orders
  where id = p_order_id and business_id = p_business_id;
  if not found then
    return null;
  end if;

  select id into v_sale_id
  from public.sales
  where order_id = p_order_id and business_id = p_business_id;
  if found then
    return v_sale_id;
  end if;

  -- Solo cuenta lo entregado. Un pedido pendiente o cancelado no es dinero.
  -- Hoy quien decide es `set_order_status`, que solo llama aquí al pasar a
  -- 'completado' — pero esta función es SECURITY DEFINER y está concedida a
  -- service_role, así que un `db.rpc()` distraído facturaría un pedido
  -- cancelado. La misma guardia que ya tenía `crear_venta_desde_estadia`.
  if v_order.status is distinct from 'completado' then
    return null;
  end if;

  insert into public.sales (
    business_id, order_id, contact_phone, contact_name,
    total, status, source, sold_at
  ) values (
    p_business_id, p_order_id,
    -- 'mostrador' no es el teléfono de nadie: la venta va sin contacto.
    nullif(v_order.contact_phone, 'mostrador'),
    v_order.contact_name,
    v_order.total, 'completada',
    case
      when v_order.source = 'storefront' then 'tienda'
      when v_order.source = 'manual' then 'mostrador'
      else 'bot'
    end,
    now()
  )
  returning id into v_sale_id;

  insert into public.sale_items (
    sale_id, business_id, product_id, product_name, quantity, unit_price, line_total
  )
  select
    v_sale_id, p_business_id, oi.product_id,
    oi.product_name || coalesce(' (' || oi.variant_name || ')', ''),
    oi.quantity, oi.unit_price, oi.line_total
  from public.order_items oi
  where oi.order_id = p_order_id and oi.business_id = p_business_id;

  return v_sale_id;
end;
$$;

revoke all on function public.crear_venta_desde_pedido(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.crear_venta_desde_pedido(uuid, uuid) to service_role;

create or replace function public.set_order_status(
  p_business_id uuid,
  p_order_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_anterior text;
begin
  if p_status not in (
    'pendiente', 'esperando_pago', 'pago_en_revision', 'confirmado', 'aceptado',
    'preparacion', 'listo_para_retiro', 'en_camino', 'completado',
    'cancelado', 'rechazado', 'expirado'
  ) then
    raise exception using errcode = '22023', message = 'Estado de pedido inválido';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id and business_id = p_business_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found', 'order', null);
  end if;

  if v_order.status = p_status then
    return jsonb_build_object('result', 'updated', 'order', to_jsonb(v_order));
  end if;
  v_anterior := v_order.status;

  -- Un pedido que el cliente retira en el local (o consume en sitio) no puede
  -- salir a reparto. Los pedidos del bot no traen `fulfillment`: se asumen a
  -- domicilio, que es como funcionan hoy por WhatsApp.
  if p_status = 'en_camino'
     and coalesce(v_order.fulfillment, 'delivery') <> 'delivery' then
    return jsonb_build_object('result', 'not_deliverable', 'order', to_jsonb(v_order));
  end if;

  -- Y al revés: un pedido a domicilio no se queda «listo para retirar».
  if p_status = 'listo_para_retiro'
     and coalesce(v_order.fulfillment, 'delivery') = 'delivery' then
    return jsonb_build_object('result', 'not_pickable', 'order', to_jsonb(v_order));
  end if;

  -- El pedido avanza; nunca retrocede. `completado`, `cancelado`, `rechazado`
  -- y `expirado` son finales: de ahí no sale a ningún sitio, así que
  -- «cancelado → preparacion» o «completado → preparacion» quedan fuera por no
  -- estar listados, no por una regla aparte.
  if not (
    (v_order.status = 'pendiente'
      and p_status in ('esperando_pago', 'pago_en_revision', 'confirmado', 'aceptado',
                       'preparacion', 'cancelado', 'rechazado', 'expirado'))
    or (v_order.status = 'esperando_pago'
      and p_status in ('pago_en_revision', 'confirmado', 'cancelado', 'expirado'))
    -- El comprobante está subido y el dueño lo revisa: de aquí sale aceptado o
    -- rechazado, nunca directo a la cocina.
    or (v_order.status = 'pago_en_revision'
      and p_status in ('confirmado', 'aceptado', 'rechazado', 'cancelado', 'expirado'))
    or (v_order.status = 'confirmado'
      and p_status in ('aceptado', 'preparacion', 'listo_para_retiro', 'en_camino',
                       'completado', 'cancelado', 'expirado'))
    or (v_order.status = 'aceptado'
      and p_status in ('preparacion', 'listo_para_retiro', 'en_camino', 'completado',
                       'cancelado'))
    or (v_order.status = 'preparacion'
      and p_status in ('listo_para_retiro', 'en_camino', 'completado', 'cancelado'))
    or (v_order.status = 'listo_para_retiro'
      and p_status in ('completado', 'cancelado'))
    or (v_order.status = 'en_camino'
      and p_status in ('completado', 'cancelado'))
  ) then
    return jsonb_build_object('result', 'invalid_transition', 'order', to_jsonb(v_order));
  end if;

  update public.orders
  set status = p_status, updated_at = now()
  where id = p_order_id and business_id = p_business_id
  returning * into v_order;

  -- El historial. Sin esto, «¿cuándo se confirmó?» solo se puede responder
  -- mirando `updated_at`, que se pisa con cada cambio.
  insert into public.order_events (business_id, order_id, from_status, to_status)
  values (p_business_id, p_order_id, v_anterior, p_status);

  -- Entregado = vendido. Si algo fallara aquí cae la transacción entera: nunca
  -- queda un pedido entregado sin su venta.
  if p_status = 'completado' then
    perform public.crear_venta_desde_pedido(p_business_id, p_order_id);
  end if;

  return jsonb_build_object('result', 'updated', 'order', to_jsonb(v_order));
end;
$$;

revoke all on function public.set_order_status(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.set_order_status(uuid, uuid, text) to service_role;

-- ── FUNCIÓN ATÓMICA: reserva si el intervalo sigue libre ───
create or replace function public.create_booking_if_available(
  p_business_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_service text,
  p_booking_date date,
  p_booking_time time,
  p_duration_minutes integer default null,
  p_notes text default null
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_booking public.bookings%rowtype;
  v_schedule public.business_schedule%rowtype;
  v_business_accepts_bookings boolean;
  v_duration integer;
  v_local_now timestamp := now() at time zone 'America/Guayaquil';
begin
  if p_business_id is null then
    raise exception using errcode = '22023', message = 'El negocio es obligatorio';
  end if;
  if nullif(btrim(p_contact_phone), '') is null then
    raise exception using errcode = '22023', message = 'El contacto es obligatorio';
  end if;
  if p_booking_date is null or p_booking_time is null then
    raise exception using errcode = '22023', message = 'La fecha y hora son obligatorias';
  end if;
  if p_booking_date + p_booking_time <= v_local_now then
    raise exception using errcode = '22023', message = 'La reserva debe estar en el futuro';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_business_id::text || ':' || p_booking_date::text, 0)
  );

  select (
    business.takes_bookings is true
    and business.active is true
    and business.suspended is not true
  )
  into v_business_accepts_bookings
  from public.businesses as business
  where business.id = p_business_id
  for share;

  if not found then
    raise exception using errcode = '23503', message = 'El negocio no existe';
  end if;
  if v_business_accepts_bookings is distinct from true then
    raise exception using errcode = '42501', message = 'El negocio no acepta reservas';
  end if;

  select schedule.*
  into v_schedule
  from public.business_schedule as schedule
  where schedule.business_id = p_business_id
    and schedule.day_of_week = extract(dow from p_booking_date)::integer
    and schedule.is_active is true
  for share;

  if not found then
    raise exception using errcode = '22023', message = 'El negocio no atiende ese día';
  end if;
  if v_schedule.slot_duration not between 1 and 1440 then
    raise exception using errcode = '22023', message = 'El intervalo del horario es inválido';
  end if;

  v_duration := coalesce(p_duration_minutes, v_schedule.slot_duration, 60);
  if v_duration not between 1 and 1440 then
    raise exception using errcode = '22023', message = 'La duración de la reserva es inválida';
  end if;
  if p_booking_date + p_booking_time < p_booking_date + v_schedule.open_time
     or p_booking_date + p_booking_time + make_interval(mins => v_duration)
       > p_booking_date + v_schedule.close_time then
    raise exception using errcode = '22023', message = 'La reserva queda fuera del horario de atención';
  end if;
  if mod(
    extract(epoch from (p_booking_time - v_schedule.open_time)),
    v_schedule.slot_duration * 60
  ) <> 0 then
    raise exception using errcode = '22023', message = 'La hora no corresponde a un intervalo disponible';
  end if;

  select booking.*
  into v_booking
  from public.bookings as booking
  where booking.business_id = p_business_id
    and booking.contact_phone = btrim(p_contact_phone)
    and booking.booking_date = p_booking_date
    and booking.booking_time = p_booking_time
    and lower(coalesce(btrim(booking.service), ''))
      = lower(coalesce(btrim(p_service), ''))
    and booking.status in ('pending', 'confirmed')
  order by booking.created_at
  limit 1;

  if found then
    return jsonb_build_object(
      'result', 'duplicate',
      'booking', to_jsonb(v_booking)
    );
  end if;

  if exists (
    select 1
    from public.bookings as booking
    where booking.business_id = p_business_id
      and booking.booking_date = p_booking_date
      and booking.status in ('pending', 'confirmed')
      and p_booking_date + p_booking_time
        < booking.booking_date + booking.booking_time
          + make_interval(mins => booking.duration_minutes)
      and booking.booking_date + booking.booking_time
        < p_booking_date + p_booking_time + make_interval(mins => v_duration)
  ) then
    return jsonb_build_object('result', 'conflict', 'booking', null);
  end if;

  insert into public.bookings (
    business_id, contact_phone, contact_name, service,
    booking_date, booking_time, duration_minutes, notes, status
  ) values (
    p_business_id, btrim(p_contact_phone), nullif(btrim(p_contact_name), ''),
    nullif(btrim(p_service), ''), p_booking_date, p_booking_time, v_duration,
    nullif(btrim(p_notes), ''), 'pending'
  ) returning * into v_booking;

  return jsonb_build_object('result', 'created', 'booking', to_jsonb(v_booking));
exception
  when exclusion_violation then
    return jsonb_build_object('result', 'conflict', 'booking', null);
end;
$$;

revoke all on function public.create_booking_if_available(uuid, text, text, text, date, time, integer, text) from public;
revoke all on function public.create_booking_if_available(uuid, text, text, text, date, time, integer, text) from anon;
revoke all on function public.create_booking_if_available(uuid, text, text, text, date, time, integer, text) from authenticated;
grant execute on function public.create_booking_if_available(uuid, text, text, text, date, time, integer, text) to service_role;

-- ── FUNCIÓN ATÓMICA: onboarding completo ───────────────────
-- Crea negocio, políticas, dueño y cuotas en una sola transacción.
create or replace function public.create_business_onboarding(
  p_business jsonb,
  p_client_email text default null,
  p_password_hash text default null,
  p_monthly_rate numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business businesses%rowtype;
  v_name text := btrim(coalesce(p_business ->> 'name', ''));
  v_slug text := btrim(coalesce(p_business ->> 'slug', ''));
  v_whatsapp_number text := btrim(coalesce(p_business ->> 'whatsapp_number', ''));
  v_client_email text := nullif(btrim(coalesce(p_client_email, '')), '');
  v_password_hash text := nullif(p_password_hash, '');
begin
  if jsonb_typeof(p_business) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Los datos del negocio son inválidos';
  end if;
  if v_name = '' or v_slug = '' or v_whatsapp_number = '' then
    raise exception using errcode = '22023', message = 'Nombre, slug y número son obligatorios';
  end if;
  if (v_client_email is null) <> (v_password_hash is null) then
    raise exception using errcode = '22023', message = 'Email y contraseña deben enviarse juntos';
  end if;
  if v_password_hash is not null and v_password_hash !~ '^\$2[aby]\$[0-9]{2}\$' then
    raise exception using errcode = '22023', message = 'La contraseña debe llegar cifrada';
  end if;
  if p_monthly_rate is not null and p_monthly_rate <= 0 then
    raise exception using errcode = '22023', message = 'La tarifa mensual debe ser mayor que cero';
  end if;

  insert into businesses (
    slug, name, type, whatsapp_number, whatsapp_provider,
    ycloud_api_key, ycloud_number,
    ycloud_webhook_endpoint_id, ycloud_webhook_secret,
    meta_token, meta_phone_id, telegram_bot_token,
    takes_bookings, takes_orders, ai_provider, owner_phone, plan,
    plan_expires_at, active, bot_active, suspended, notes, monthly_rate
  ) values (
    v_slug,
    v_name,
    coalesce(nullif(p_business ->> 'type', ''), 'negocio'),
    v_whatsapp_number,
    coalesce(nullif(p_business ->> 'whatsapp_provider', ''), 'ycloud'),
    nullif(p_business ->> 'ycloud_api_key', ''),
    nullif(p_business ->> 'ycloud_number', ''),
    nullif(btrim(p_business ->> 'ycloud_webhook_endpoint_id'), ''),
    nullif(p_business ->> 'ycloud_webhook_secret', ''),
    nullif(p_business ->> 'meta_token', ''),
    nullif(p_business ->> 'meta_phone_id', ''),
    nullif(p_business ->> 'telegram_bot_token', ''),
    coalesce((p_business ->> 'takes_bookings')::boolean, false),
    coalesce((p_business ->> 'takes_orders')::boolean, true),
    nullif(p_business ->> 'ai_provider', ''),
    nullif(p_business ->> 'owner_phone', ''),
    coalesce(nullif(p_business ->> 'plan', ''), 'basic'),
    nullif(p_business ->> 'plan_expires_at', '')::timestamptz,
    true,
    true,
    false,
    nullif(p_business ->> 'notes', ''),
    p_monthly_rate
  ) returning * into v_business;

  insert into bot_policies (business_id) values (v_business.id);

  insert into business_schedule (
    business_id, day_of_week, open_time, close_time, slot_duration, is_active
  ) values
    (v_business.id, 0, '09:00', '18:00', 60, false),
    (v_business.id, 1, '09:00', '18:00', 60, true),
    (v_business.id, 2, '09:00', '18:00', 60, true),
    (v_business.id, 3, '09:00', '18:00', 60, true),
    (v_business.id, 4, '09:00', '18:00', 60, true),
    (v_business.id, 5, '09:00', '18:00', 60, true),
    (v_business.id, 6, '09:00', '13:00', 60, true)
  on conflict (business_id, day_of_week) do nothing;

  if v_client_email is not null then
    insert into client_users (business_id, email, password_hash, role)
    values (v_business.id, v_client_email, v_password_hash, 'owner');
  end if;

  if p_monthly_rate is not null then
    insert into billing (business_id, amount, status, period_start, period_end)
    select
      v_business.id,
      p_monthly_rate,
      'pending',
      (date_trunc('month', current_date) + make_interval(months => month_offset))::date,
      (date_trunc('month', current_date) + make_interval(months => month_offset + 1)
        - interval '1 day')::date
    from generate_series(0, 11) as month_offset;
  end if;

  return to_jsonb(v_business);
end;
$$;

revoke all on function public.create_business_onboarding(jsonb, text, text, numeric) from public;
revoke all on function public.create_business_onboarding(jsonb, text, text, numeric) from anon;
revoke all on function public.create_business_onboarding(jsonb, text, text, numeric) from authenticated;
grant execute on function public.create_business_onboarding(jsonb, text, text, numeric) to service_role;
-- ⚠️ Aquí vivía `create_sale_with_items`, el alta MANUAL de ventas. Se retiró
-- el 2026-08-02 (migration-2026-08-02-retirar-venta-manual.sql): desde
-- entonces toda venta nace de un pedido entregado, un pedido de mostrador o
-- una cita atendida. Un solo camino hasta el reporte.

-- ── INBOX DURABLE DE WEBHOOKS ──────────────────────────────
create or replace function public.enqueue_webhook_event(
  p_business_id uuid,
  p_provider text,
  p_message_id_hash text,
  p_stream_key_hash text,
  p_payload jsonb
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_event_id uuid;
  v_received_at timestamptz;
  v_quiet_until timestamptz;
  v_is_text boolean;
begin
  if p_business_id is null then
    raise exception using errcode = '22023', message = 'El negocio es obligatorio';
  end if;
  if p_provider not in ('meta', 'ycloud') then
    raise exception using errcode = '22023', message = 'Proveedor de webhook invalido';
  end if;
  if p_message_id_hash is null
     or p_message_id_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Hash de mensaje invalido';
  end if;
  if p_stream_key_hash is null
     or p_stream_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Hash de conversacion invalido';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object'
     or pg_column_size(p_payload) > 262144
     or p_payload ? '_inboxBatch' then
    raise exception using errcode = '22023', message = 'Payload de webhook invalido';
  end if;

  v_is_text := coalesce((
    p_payload #>> '{content,kind}' = 'text'
    and jsonb_typeof(p_payload #> '{content,text}') = 'string'
  ), false);
  -- Serializa solamente los enqueue del mismo stream. Así dos textos
  -- concurrentes observan la ventana más reciente y un duplicado nunca la
  -- prolonga. Una colisión del hash solo reduce concurrencia, no mezcla datos.
  perform pg_advisory_xact_lock(hashtextextended(
    p_business_id::text || ':' || p_provider || ':' || p_stream_key_hash,
    0
  ));
  v_received_at := clock_timestamp();
  v_quiet_until := v_received_at + interval '3 seconds';

  insert into public.webhook_inbound_events (
    business_id,
    provider,
    message_id_hash,
    stream_key_hash,
    payload_version,
    payload,
    status,
    attempts,
    max_attempts,
    available_at,
    completed_at,
    dead_at,
    received_at,
    updated_at
  ) values (
    p_business_id,
    p_provider,
    p_message_id_hash,
    p_stream_key_hash,
    1,
    p_payload,
    'pending',
    0,
    8,
    case when v_is_text then v_quiet_until else now() end,
    null,
    null,
    v_received_at,
    v_received_at
  )
  on conflict (business_id, provider, message_id_hash) do nothing
  returning id into v_event_id;

  if not found then
    return false;
  end if;

  if v_is_text then
    update public.webhook_inbound_events as queued
    set available_at = greatest(queued.available_at, v_quiet_until),
        updated_at = clock_timestamp()
    where queued.business_id = p_business_id
      and queued.provider = p_provider
      and queued.stream_key_hash = p_stream_key_hash
      and queued.status = 'pending'
      and queued.payload #>> '{content,kind}' = 'text'
      and jsonb_typeof(queued.payload #> '{content,text}') = 'string'
      and not (queued.payload ? '_inboxBatch')
      and (queued.received_at, queued.id) <= (v_received_at, v_event_id)
      -- Una imagen/audio (o un lote ya congelado) separa conversaciones
      -- textuales aunque haya más textos pendientes después de esa frontera.
      and not exists (
        select 1
        from public.webhook_inbound_events as boundary
        where boundary.business_id = queued.business_id
          and boundary.provider = queued.provider
          and boundary.stream_key_hash = queued.stream_key_hash
          and boundary.status in ('pending', 'processing')
          and (boundary.received_at, boundary.id)
            > (queued.received_at, queued.id)
          and (boundary.received_at, boundary.id)
            < (v_received_at, v_event_id)
          and (
            boundary.payload #>> '{content,kind}' is distinct from 'text'
            or boundary.payload ? '_inboxBatch'
          )
      );
  end if;

  return true;
end;
$$;

create or replace function public.lease_webhook_events(
  p_worker_id text,
  p_limit integer,
  p_lease_seconds integer
)
returns table (
  id uuid,
  business_id uuid,
  provider text,
  payload jsonb,
  lease_token uuid,
  attempts integer
)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 50));
  v_lease_seconds integer := greatest(
    30, least(coalesce(p_lease_seconds, 180), 900)
  );
  v_head record;
  v_batch_ids uuid[];
  v_combined_text text;
  v_latest_inbound_id text;
  v_payload jsonb;
  v_lease_token uuid;
  v_attempts integer;
  v_frozen boolean;
  v_terminal_head record;
  v_terminal_ids uuid[];
  v_terminal_locked_ids uuid[];
  v_terminal_member record;
  v_terminal_distinct integer;
  v_terminal_updated integer;
  v_has_terminal_snapshot boolean;
begin
  if nullif(btrim(p_worker_id), '') is null
     or char_length(p_worker_id) > 128 then
    raise exception using errcode = '22023', message = 'Worker ID invalido';
  end if;

  -- Si venció el último lease, toda la foto congelada va a dead-letter.
  -- Dejar sus miembros pending permitiría que se procesen otra vez después de
  -- que la cabeza ya pudo haber enviado una respuesta antes de morir.
  for v_terminal_head in
    select event.*
    from public.webhook_inbound_events as event
    where event.status = 'processing'
      and event.leased_until <= now()
      and event.attempts >= event.max_attempts
    order by event.received_at, event.id
    for update of event skip locked
    limit 100
  loop
    v_terminal_ids := array[v_terminal_head.id];
    v_has_terminal_snapshot := false;

    if (v_terminal_head.payload #>> '{_inboxBatch,version}') = '1'
       and jsonb_typeof(
         v_terminal_head.payload #> '{_inboxBatch,eventIds}'
       ) = 'array' then
      if jsonb_array_length(
        v_terminal_head.payload #> '{_inboxBatch,eventIds}'
      ) between 1 and 20
         and not exists (
           select 1
           from jsonb_array_elements(
             v_terminal_head.payload #> '{_inboxBatch,eventIds}'
           ) as item(value)
           where jsonb_typeof(item.value) is distinct from 'string'
              or (item.value #>> '{}') !~
                '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         ) then
        select array_agg(
          (item.value #>> '{}')::uuid
          order by item.ordinality
        )
        into v_terminal_ids
        from jsonb_array_elements(
          v_terminal_head.payload #> '{_inboxBatch,eventIds}'
        ) with ordinality as item(value, ordinality);

        select count(distinct member.id)::integer
        into v_terminal_distinct
        from unnest(v_terminal_ids) as member(id);

        v_has_terminal_snapshot :=
          v_terminal_ids[1] = v_terminal_head.id
          and v_terminal_distinct = cardinality(v_terminal_ids);
      end if;
    end if;

    if v_has_terminal_snapshot then
      v_terminal_locked_ids := array[]::uuid[];
      for v_terminal_member in
        select event.*
        from public.webhook_inbound_events as event
        where event.id = any(v_terminal_ids)
        order by event.received_at, event.id
        for update
      loop
        if v_terminal_member.business_id is distinct from v_terminal_head.business_id
           or v_terminal_member.provider is distinct from v_terminal_head.provider
           or v_terminal_member.stream_key_hash
             is distinct from v_terminal_head.stream_key_hash
           or v_terminal_member.payload #>> '{content,kind}'
             is distinct from 'text'
           or (
             v_terminal_member.id = v_terminal_head.id
             and (
               v_terminal_member.status is distinct from 'processing'
               or v_terminal_member.lease_token
                 is distinct from v_terminal_head.lease_token
             )
           )
           or (
             v_terminal_member.id <> v_terminal_head.id
             and (
               v_terminal_member.status is distinct from 'pending'
               or v_terminal_member.lease_token is not null
             )
           ) then
          raise exception using
            errcode = '40001',
            message = 'El lote expirado del webhook cambió antes de dead-letter';
        end if;
        v_terminal_locked_ids := array_append(
          v_terminal_locked_ids,
          v_terminal_member.id
        );
      end loop;

      if v_terminal_locked_ids is distinct from v_terminal_ids then
        raise exception using
          errcode = '40001',
          message = 'El lote expirado del webhook está incompleto';
      end if;
    else
      v_terminal_ids := array[v_terminal_head.id];
    end if;

    update public.webhook_inbound_events as event
    set status = 'dead',
        lease_token = null,
        lease_owner = null,
        leased_until = null,
        last_error = coalesce(
          event.last_error,
          'Lease vencido despues del ultimo intento'
        ),
        completed_at = null,
        dead_at = now(),
        updated_at = now()
    where event.id = any(v_terminal_ids)
      and event.business_id = v_terminal_head.business_id
      and event.provider = v_terminal_head.provider
      and event.stream_key_hash = v_terminal_head.stream_key_hash
      and (
        (
          event.id = v_terminal_head.id
          and event.status = 'processing'
          and event.lease_token = v_terminal_head.lease_token
        )
        or (
          event.id <> v_terminal_head.id
          and event.status = 'pending'
          and event.lease_token is null
        )
      );

    get diagnostics v_terminal_updated = row_count;
    if v_terminal_updated <> cardinality(v_terminal_ids) then
      raise exception using
        errcode = '40001',
        message = 'El lote expirado cambió durante su terminalización';
    end if;
  end loop;

  update public.webhook_inbound_events as event
  set status = 'pending',
      available_at = least(event.available_at, now()),
      lease_token = null,
      lease_owner = null,
      leased_until = null,
      updated_at = now()
  where event.status = 'processing'
    and event.leased_until <= now()
    and event.attempts < event.max_attempts;

  for v_head in
    select event.*
    from public.webhook_inbound_events as event
    where event.status = 'pending'
      and event.available_at <= now()
      and event.attempts < event.max_attempts
      and not exists (
        select 1
        from public.webhook_inbound_events as earlier
        where earlier.business_id = event.business_id
          and earlier.provider = event.provider
          and earlier.stream_key_hash = event.stream_key_hash
          and earlier.status in ('pending', 'processing')
          and (earlier.received_at, earlier.id)
            < (event.received_at, event.id)
      )
    order by event.received_at, event.id
    for update of event skip locked
    limit v_limit
  loop
    v_payload := v_head.payload;
    v_batch_ids := null;
    v_combined_text := null;
    v_latest_inbound_id := null;
    v_frozen := case
      when (v_head.payload #>> '{_inboxBatch,version}') = '1'
       and jsonb_typeof(
         v_head.payload #> '{_inboxBatch,eventIds}'
       ) = 'array'
      then jsonb_array_length(
        v_head.payload #> '{_inboxBatch,eventIds}'
      ) between 1 and 20
        and (v_head.payload #>> '{_inboxBatch,eventIds,0}') = v_head.id::text
      else false
    end;

    -- Un retry conserva exactamente el snapshot anterior. Los mensajes que
    -- llegaron después quedan pendientes para el siguiente lote.
    if not v_frozen
       and v_head.payload #>> '{content,kind}' = 'text'
       and jsonb_typeof(v_head.payload #> '{content,text}') = 'string' then
      with eligible as (
        select
          member.id,
          member.payload,
          member.received_at,
          row_number() over (
            order by member.received_at, member.id
          ) as batch_position,
          sum(
            char_length(member.payload #>> '{content,text}')
            + case when member.id = v_head.id then 0 else 1 end
          ) over (
            order by member.received_at, member.id
            rows between unbounded preceding and current row
          ) as combined_length
        from public.webhook_inbound_events as member
        where member.business_id = v_head.business_id
          and member.provider = v_head.provider
          and member.stream_key_hash = v_head.stream_key_hash
          and member.status = 'pending'
          and member.available_at <= now()
          and member.attempts < member.max_attempts
          and member.payload #>> '{content,kind}' = 'text'
          and jsonb_typeof(member.payload #> '{content,text}') = 'string'
          and not (member.payload ? '_inboxBatch')
          and (member.received_at, member.id)
            >= (v_head.received_at, v_head.id)
          -- No salta una frontera no textual, un retry congelado ni una fila
          -- todavía no disponible: solo toma un prefijo consecutivo.
          and not exists (
            select 1
            from public.webhook_inbound_events as boundary
            where boundary.business_id = v_head.business_id
              and boundary.provider = v_head.provider
              and boundary.stream_key_hash = v_head.stream_key_hash
              and boundary.status in ('pending', 'processing')
              and (boundary.received_at, boundary.id)
                >= (v_head.received_at, v_head.id)
              and (boundary.received_at, boundary.id)
                < (member.received_at, member.id)
              and (
                boundary.payload #>> '{content,kind}' is distinct from 'text'
                or jsonb_typeof(boundary.payload #> '{content,text}')
                  is distinct from 'string'
                or boundary.payload ? '_inboxBatch'
                or boundary.available_at > now()
                or boundary.attempts >= boundary.max_attempts
              )
          )
      ), bounded as (
        select *
        from eligible
        where batch_position <= 20
          and combined_length <= 16384
      )
      select
        array_agg(bounded.id order by bounded.received_at, bounded.id),
        string_agg(
          bounded.payload #>> '{content,text}',
          E'\n'
          order by bounded.received_at, bounded.id
        ),
        (
          array_agg(
            bounded.payload ->> 'inboundId'
            order by bounded.received_at desc, bounded.id desc
          )
        )[1]
      into v_batch_ids, v_combined_text, v_latest_inbound_id
      from bounded;

      -- Los payloads normalizados válidos siempre incluyen la cabeza. Este
      -- fallback conserva el fallo/retry de una fila histórica malformada sin
      -- permitir que se apropie de otros IDs.
      if v_batch_ids is null
         or v_batch_ids[1] is distinct from v_head.id then
        v_batch_ids := array[v_head.id];
        v_combined_text := v_head.payload #>> '{content,text}';
        v_latest_inbound_id := v_head.payload ->> 'inboundId';
      end if;

      v_payload := jsonb_set(
        jsonb_set(
          v_head.payload - '_inboxBatch',
          '{content,text}',
          to_jsonb(v_combined_text),
          false
        ),
        '{inboundId}',
        to_jsonb(v_latest_inbound_id),
        false
      ) || jsonb_build_object(
        '_inboxBatch',
        jsonb_build_object(
          'version', 1,
          'eventIds', to_jsonb(v_batch_ids)
        )
      );
    elsif not v_frozen then
      -- _inboxBatch es un namespace interno reservado; nunca se confía en
      -- metadata presente en un payload histórico no textual.
      v_payload := v_head.payload - '_inboxBatch';
    end if;

    update public.webhook_inbound_events as event
    set status = 'processing',
        attempts = event.attempts + 1,
        payload = v_payload,
        lease_token = gen_random_uuid(),
        lease_owner = btrim(p_worker_id),
        leased_until = now() + make_interval(secs => v_lease_seconds),
        updated_at = now()
    where event.id = v_head.id
      and event.status = 'pending'
    returning event.lease_token, event.attempts
      into v_lease_token, v_attempts;

    if found then
      id := v_head.id;
      business_id := v_head.business_id;
      provider := v_head.provider;
      payload := v_payload;
      lease_token := v_lease_token;
      attempts := v_attempts;
      return next;
    end if;
  end loop;
end;
$$;

create or replace function public.renew_webhook_event_lease(
  p_event_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_renewed integer;
  v_lease_seconds integer := greatest(
    30, least(coalesce(p_lease_seconds, 180), 900)
  );
begin
  if p_event_id is null or p_lease_token is null then return false; end if;

  update public.webhook_inbound_events as event
  set leased_until = now() + make_interval(secs => v_lease_seconds),
      updated_at = now()
  where event.id = p_event_id
    and event.status = 'processing'
    and event.lease_token = p_lease_token
    and event.leased_until > now();

  get diagnostics v_renewed = row_count;
  return v_renewed = 1;
end;
$$;

create or replace function public.complete_webhook_event(
  p_event_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_head record;
  v_batch jsonb;
  v_batch_ids uuid[];
  v_locked_ids uuid[] := array[]::uuid[];
  v_member record;
  v_distinct_count integer;
  v_completed integer;
begin
  if p_event_id is null or p_lease_token is null then return false; end if;

  select event.*
  into v_head
  from public.webhook_inbound_events as event
  where event.id = p_event_id
    and event.status = 'processing'
    and event.lease_token = p_lease_token
  for update;

  if not found then return false; end if;

  v_batch := v_head.payload -> '_inboxBatch';
  if v_batch is null then
    update public.webhook_inbound_events as event
    set status = 'completed',
        payload = null,
        lease_token = null,
        lease_owner = null,
        leased_until = null,
        last_error = null,
        completed_at = now(),
        dead_at = null,
        updated_at = now()
    where event.id = p_event_id
      and event.status = 'processing'
      and event.lease_token = p_lease_token;

    get diagnostics v_completed = row_count;
    return v_completed = 1;
  end if;

  if jsonb_typeof(v_batch) is distinct from 'object'
     or (v_batch ->> 'version') is distinct from '1'
     or jsonb_typeof(v_batch -> 'eventIds') is distinct from 'array' then
    return false;
  end if;

  if jsonb_array_length(v_batch -> 'eventIds') not between 1 and 20 then
    return false;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_batch -> 'eventIds') as item(value)
    where jsonb_typeof(item.value) is distinct from 'string'
       or (item.value #>> '{}') !~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) then
    return false;
  end if;

  select array_agg(
    (item.value #>> '{}')::uuid
    order by item.ordinality
  )
  into v_batch_ids
  from jsonb_array_elements(v_batch -> 'eventIds')
    with ordinality as item(value, ordinality);

  if v_batch_ids[1] is distinct from p_event_id then return false; end if;

  select count(distinct member.id)::integer
  into v_distinct_count
  from unnest(v_batch_ids) as member(id);
  if v_distinct_count <> cardinality(v_batch_ids) then return false; end if;

  -- Bloquea todos los miembros antes de validar o mutar. La comparación del
  -- orden impide completar IDs ajenos o saltar una frontera FIFO.
  for v_member in
    select event.*
    from public.webhook_inbound_events as event
    where event.id = any(v_batch_ids)
    order by event.received_at, event.id
    for update
  loop
    if v_member.business_id is distinct from v_head.business_id
       or v_member.provider is distinct from v_head.provider
       or v_member.stream_key_hash is distinct from v_head.stream_key_hash
       or v_member.payload #>> '{content,kind}' is distinct from 'text'
       or (
         v_member.id = p_event_id
         and (
           v_member.status is distinct from 'processing'
           or v_member.lease_token is distinct from p_lease_token
         )
       )
       or (
         v_member.id <> p_event_id
         and (
           v_member.status is distinct from 'pending'
           or v_member.lease_token is not null
         )
       ) then
      return false;
    end if;

    v_locked_ids := array_append(v_locked_ids, v_member.id);
  end loop;

  if v_locked_ids is distinct from v_batch_ids then return false; end if;

  update public.webhook_inbound_events as event
  set status = 'completed',
      payload = null,
      lease_token = null,
      lease_owner = null,
      leased_until = null,
      last_error = null,
      completed_at = now(),
      dead_at = null,
      updated_at = now()
  where event.id = any(v_batch_ids)
    and event.business_id = v_head.business_id
    and event.provider = v_head.provider
    and event.stream_key_hash = v_head.stream_key_hash
    and (
      (
        event.id = p_event_id
        and event.status = 'processing'
        and event.lease_token = p_lease_token
      )
      or (
        event.id <> p_event_id
        and event.status = 'pending'
        and event.lease_token is null
      )
    );

  get diagnostics v_completed = row_count;
  if v_completed <> cardinality(v_batch_ids) then
    raise exception using
      errcode = '40001',
      message = 'El lote del webhook cambió durante su finalización';
  end if;

  return true;
end;
$$;

create or replace function public.fail_webhook_event(
  p_event_id uuid,
  p_lease_token uuid,
  p_error text,
  p_base_delay_seconds integer
)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_head record;
  v_base_delay integer := greatest(
    1, least(coalesce(p_base_delay_seconds, 5), 300)
  );
  v_delay_seconds integer;
  v_error text := left(
    coalesce(nullif(btrim(p_error), ''), 'Error de procesamiento'),
    2000
  );
  v_batch_ids uuid[];
  v_locked_ids uuid[];
  v_member record;
  v_distinct_count integer;
  v_updated integer;
  v_has_snapshot boolean;
begin
  if p_event_id is null or p_lease_token is null then return 'stale'; end if;

  select event.*
  into v_head
  from public.webhook_inbound_events as event
  where event.id = p_event_id
    and event.status = 'processing'
    and event.lease_token = p_lease_token
  for update;

  if not found then return 'stale'; end if;

  if v_head.attempts >= v_head.max_attempts then
    v_batch_ids := array[v_head.id];
    v_has_snapshot := false;

    if (v_head.payload #>> '{_inboxBatch,version}') = '1'
       and jsonb_typeof(
         v_head.payload #> '{_inboxBatch,eventIds}'
       ) = 'array' then
      if jsonb_array_length(
        v_head.payload #> '{_inboxBatch,eventIds}'
      ) between 1 and 20
         and not exists (
           select 1
           from jsonb_array_elements(
             v_head.payload #> '{_inboxBatch,eventIds}'
           ) as item(value)
           where jsonb_typeof(item.value) is distinct from 'string'
              or (item.value #>> '{}') !~
                '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         ) then
        select array_agg(
          (item.value #>> '{}')::uuid
          order by item.ordinality
        )
        into v_batch_ids
        from jsonb_array_elements(
          v_head.payload #> '{_inboxBatch,eventIds}'
        ) with ordinality as item(value, ordinality);

        select count(distinct member.id)::integer
        into v_distinct_count
        from unnest(v_batch_ids) as member(id);

        v_has_snapshot := v_batch_ids[1] = v_head.id
          and v_distinct_count = cardinality(v_batch_ids);
      end if;
    end if;

    if v_has_snapshot then
      v_locked_ids := array[]::uuid[];
      for v_member in
        select event.*
        from public.webhook_inbound_events as event
        where event.id = any(v_batch_ids)
        order by event.received_at, event.id
        for update
      loop
        if v_member.business_id is distinct from v_head.business_id
           or v_member.provider is distinct from v_head.provider
           or v_member.stream_key_hash is distinct from v_head.stream_key_hash
           or v_member.payload #>> '{content,kind}' is distinct from 'text'
           or (
             v_member.id = p_event_id
             and (
               v_member.status is distinct from 'processing'
               or v_member.lease_token is distinct from p_lease_token
             )
           )
           or (
             v_member.id <> p_event_id
             and (
               v_member.status is distinct from 'pending'
               or v_member.lease_token is not null
             )
           ) then
          raise exception using
            errcode = '40001',
            message = 'El lote fallido del webhook cambió antes de dead-letter';
        end if;
        v_locked_ids := array_append(v_locked_ids, v_member.id);
      end loop;

      if v_locked_ids is distinct from v_batch_ids then
        raise exception using
          errcode = '40001',
          message = 'El lote fallido del webhook está incompleto';
      end if;
    else
      v_batch_ids := array[v_head.id];
    end if;

    update public.webhook_inbound_events as event
    set status = 'dead',
        lease_token = null,
        lease_owner = null,
        leased_until = null,
        last_error = v_error,
        completed_at = null,
        dead_at = now(),
        updated_at = now()
    where event.id = any(v_batch_ids)
      and event.business_id = v_head.business_id
      and event.provider = v_head.provider
      and event.stream_key_hash = v_head.stream_key_hash
      and (
        (
          event.id = p_event_id
          and event.status = 'processing'
          and event.lease_token = p_lease_token
        )
        or (
          event.id <> p_event_id
          and event.status = 'pending'
          and event.lease_token is null
        )
      );

    get diagnostics v_updated = row_count;
    if v_updated <> cardinality(v_batch_ids) then
      raise exception using
        errcode = '40001',
        message = 'El lote fallido cambió durante su terminalización';
    end if;
    return 'dead';
  end if;

  -- 5s, 10s, 20s... con base configurable, jitter y tope de 15 min.
  v_delay_seconds := least(
    900,
    v_base_delay
      * power(
        2::numeric,
        least(greatest(v_head.attempts - 1, 0), 10)
      )::integer
      + floor(random() * least(v_base_delay, 30))::integer
  );

  update public.webhook_inbound_events as event
  set status = 'pending',
      available_at = now() + make_interval(secs => v_delay_seconds),
      lease_token = null,
      lease_owner = null,
      leased_until = null,
      last_error = v_error,
      dead_at = null,
      updated_at = now()
  where event.id = p_event_id
    and event.status = 'processing'
    and event.lease_token = p_lease_token;

  return 'pending';
end;
$$;

create or replace function public.cleanup_webhook_events()
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  with deleted as (
    delete from public.webhook_inbound_events as event
    where (
      event.status = 'completed'
      and coalesce(event.completed_at, event.received_at)
        < now() - interval '24 hours'
    ) or (
      event.status = 'dead'
      and coalesce(event.dead_at, event.updated_at, event.received_at)
        < now() - interval '7 days'
    )
    returning 1
  )
  select count(*)::integer into v_deleted from deleted;

  return v_deleted;
end;
$$;

-- Compatibilidad temporal con el runtime anterior.
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
  if p_provider not in ('meta', 'ycloud') then
    raise exception using errcode = '22023', message = 'Proveedor de webhook inválido';
  end if;
  if p_message_id_hash is null or p_message_id_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Hash de mensaje inválido';
  end if;

  delete from public.webhook_inbound_events
  where business_id = p_business_id
    and status = 'completed'
    and coalesce(completed_at, received_at) < now() - interval '24 hours';

  insert into public.webhook_inbound_events (
    business_id, provider, message_id_hash, status, completed_at, updated_at
  ) values (
    p_business_id, p_provider, p_message_id_hash, 'completed', now(), now()
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

revoke all on function public.enqueue_webhook_event(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.lease_webhook_events(text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.renew_webhook_event_lease(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.complete_webhook_event(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.fail_webhook_event(uuid, uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.cleanup_webhook_events()
  from public, anon, authenticated;

grant execute on function public.enqueue_webhook_event(uuid, text, text, text, jsonb)
  to service_role;
grant execute on function public.lease_webhook_events(text, integer, integer)
  to service_role;
grant execute on function public.renew_webhook_event_lease(uuid, uuid, integer)
  to service_role;
grant execute on function public.complete_webhook_event(uuid, uuid)
  to service_role;
grant execute on function public.fail_webhook_event(uuid, uuid, text, integer)
  to service_role;
grant execute on function public.cleanup_webhook_events()
  to service_role;

-- ── CATÁLOGO PARA LA TIENDA WEB DEL NEGOCIO ────────────────
-- La tienda que se abre desde WhatsApp necesita categorías con imagen,
-- variantes con precio propio y extras con coste. El precio sigue siendo
-- autoridad del servidor: estas tablas solo amplían de dónde sale.
alter table public.businesses
  add column if not exists storefront_enabled boolean not null default false;

create table if not exists public.product_categories (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  name            text not null,
  description     text,
  image_url       text,
  image_public_id text,
  sort            integer not null default 0,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint product_categories_textos_check check (
    char_length(btrim(name)) between 1 and 60
    and char_length(coalesce(description, '')) <= 300
    and sort between 0 and 999
  )
);
create index if not exists idx_product_categories_negocio
  on public.product_categories (business_id, sort);
create unique index if not exists uq_product_categories_nombre
  on public.product_categories (business_id, lower(btrim(name)));

alter table public.products
  add column if not exists category_id uuid references public.product_categories(id) on delete set null;
create index if not exists idx_products_categoria
  on public.products (business_id, category_id);

-- Un producto sin variantes sigue usando su propio `price`.
create table if not exists public.product_variants (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  product_id  uuid not null references public.products(id) on delete cascade,
  name        text not null,
  price       numeric(10,2) not null,
  price_sale  numeric(10,2),
  stock       text not null default 'disponible',
  sort        integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint product_variants_datos_check check (
    char_length(btrim(name)) between 1 and 60
    and price >= 0 and price <= 100000
    and (price_sale is null or (price_sale >= 0 and price_sale <= 100000))
    and stock in ('disponible', 'agotado')
    and sort between 0 and 999
  )
);
create index if not exists idx_product_variants_producto
  on public.product_variants (business_id, product_id, sort);
create unique index if not exists uq_product_variants_nombre
  on public.product_variants (product_id, lower(btrim(name)));

-- ── El catálogo de un negocio no se engancha al de otro ────
--
-- `product_variants` lleva business_id Y product_id, y `products` lleva
-- business_id Y category_id. Con una foránea de una sola columna, el negocio
-- salía del JWT pero el otro id viajaba en la petición: mandando un uuid ajeno
-- se colgaba una variante —con su precio— del catálogo de otro negocio.
--
-- La foránea COMPUESTA cambia la condición de "este producto existe" a "este
-- producto existe Y es de este negocio". El destino necesita un índice único
-- sobre el par para poder ser apuntado.
create unique index if not exists uq_products_id_business
  on public.products (id, business_id);
create unique index if not exists uq_product_categories_id_business
  on public.product_categories (id, business_id);

do $$
begin
  if exists (select 1 from pg_constraint
    where conname = 'product_variants_product_id_fkey'
      and conrelid = 'public.product_variants'::regclass) then
    alter table public.product_variants drop constraint product_variants_product_id_fkey;
  end if;
  if not exists (select 1 from pg_constraint
    where conname = 'fk_product_variants_producto_del_negocio'
      and conrelid = 'public.product_variants'::regclass) then
    alter table public.product_variants
      add constraint fk_product_variants_producto_del_negocio
      foreign key (product_id, business_id)
      references public.products (id, business_id) on delete cascade;
  end if;

  if exists (select 1 from pg_constraint
    where conname = 'products_category_id_fkey'
      and conrelid = 'public.products'::regclass) then
    alter table public.products drop constraint products_category_id_fkey;
  end if;
  if not exists (select 1 from pg_constraint
    where conname = 'fk_products_categoria_del_negocio'
      and conrelid = 'public.products'::regclass) then
    -- `set null (category_id)` y no `set null` a secas: sin nombrar la columna
    -- PostgreSQL anularía también `business_id`, que es NOT NULL, y borrar una
    -- categoría reventaría. Necesita PostgreSQL 15 o superior.
    alter table public.products
      add constraint fk_products_categoria_del_negocio
      foreign key (category_id, business_id)
      references public.product_categories (id, business_id)
      on delete set null (category_id);
  end if;
end $$;

-- Los extras extienden menu_modifiers en vez de duplicar el concepto: esa tabla
-- ya resuelve los sabores del modo menú y el dueño los gestiona en un solo sitio.
alter table public.menu_modifiers
  add column if not exists price_delta numeric(10,2) not null default 0,
  add column if not exists product_id uuid references public.products(id) on delete cascade,
  add column if not exists max_selectable integer;
alter table public.menu_modifiers
  alter column category_tag drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.menu_modifiers'::regclass
      and conname = 'menu_modifiers_alcance_check'
  ) then
    alter table public.menu_modifiers
      add constraint menu_modifiers_alcance_check
      check (
        (category_tag is not null or product_id is not null)
        and price_delta >= 0 and price_delta <= 100000
        and (max_selectable is null or max_selectable between 1 and 20)
      );
  end if;
end;
$$;

create index if not exists idx_menu_modifiers_producto
  on public.menu_modifiers (business_id, product_id)
  where product_id is not null;
create unique index if not exists uq_menu_modifiers_producto_nombre
  on public.menu_modifiers (business_id, product_id, lower(btrim(name)))
  where product_id is not null;

-- Datos bancarios que ve el cliente al transferir. Los publica el negocio.
create table if not exists public.business_bank_accounts (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  bank_name      text not null,
  account_type   text not null default 'ahorros',
  account_number text not null,
  holder_name    text not null,
  holder_id      text,
  instructions   text,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint business_bank_accounts_datos_check check (
    char_length(btrim(bank_name)) between 1 and 80
    and char_length(btrim(account_number)) between 1 and 40
    and char_length(btrim(holder_name)) between 1 and 120
    and account_type in ('ahorros', 'corriente')
    and char_length(coalesce(holder_id, '')) <= 20
    and char_length(coalesce(instructions, '')) <= 300
  )
);
create index if not exists idx_business_bank_accounts_negocio
  on public.business_bank_accounts (business_id, active);

-- ── CLIENTES DE LA TIENDA Y SESIONES ───────────────────────
-- La mini app no tiene registro: el cliente ya se identificó al escribir por
-- WhatsApp y el enlace que le manda el bot ES su sesión. El cliente se guarda
-- como identidad GLOBAL con una relación por negocio, así cada negocio ve lo
-- suyo y nunca sabe que ese teléfono también compra en otro sitio.
create table if not exists public.customers (
  id         uuid primary key default gen_random_uuid(),
  phone      text not null,
  name       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customers_datos_check check (
    phone ~ '^[0-9]{8,15}$' and char_length(coalesce(name, '')) <= 120
  )
);
create unique index if not exists uq_customers_phone on public.customers (phone);

create table if not exists public.business_customers (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses(id) on delete cascade,
  customer_id       uuid not null references public.customers(id) on delete cascade,
  display_name      text,
  first_order_at    timestamptz,
  last_order_at     timestamptz,
  total_orders      integer not null default 0,
  total_spent       numeric(12,2) not null default 0,
  marketing_consent boolean not null default false,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint business_customers_datos_check check (
    total_orders >= 0 and total_spent >= 0
    and char_length(coalesce(display_name, '')) <= 120
    and char_length(coalesce(notes, '')) <= 500
  )
);
create unique index if not exists uq_business_customers
  on public.business_customers (business_id, customer_id);
create index if not exists idx_business_customers_recientes
  on public.business_customers (business_id, last_order_at desc);

-- ── Modo mini app: cuándo se le mandó el enlace a este cliente ─────────────
-- Vivía en un `Map` del proceso, así que se perdía al reiniciar y no servía
-- con dos instancias (migration-2026-08-02-miniapp-enlace-24h.sql).
alter table public.business_customers
  add column if not exists storefront_link_sent_at timestamptz;

-- Por negocio a propósito: que una pizzería vea a dónde pidió ese cliente en
-- otro local sería filtrar datos entre negocios.
create table if not exists public.customer_addresses (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  label       text not null default 'Casa',
  address     text not null,
  reference   text,
  latitude    numeric(10,7),
  longitude   numeric(10,7),
  is_default  boolean not null default false,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint customer_addresses_datos_check check (
    char_length(btrim(label)) between 1 and 40
    and char_length(btrim(address)) between 1 and 300
    and char_length(coalesce(reference, '')) <= 300
    and (latitude is null or latitude between -90 and 90)
    and (longitude is null or longitude between -180 and 180)
  )
);
create index if not exists idx_customer_addresses_cliente
  on public.customer_addresses (business_id, customer_id, active);

-- Se guarda el HASH del token, nunca el token. `device_hash` se graba la PRIMERA
-- vez que se abre el enlace: a partir de ahí la sesión pertenece a ese navegador,
-- así que un enlace reenviado no sirve para comprar.
create table if not exists public.storefront_sessions (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  customer_id   uuid not null references public.customers(id) on delete cascade,
  token_hash    text not null,
  contact_phone text not null,
  device_hash   text,
  claimed_at    timestamptz,
  -- Nulo = no caduca. Es el caso normal desde el 2026-08-02
  -- (migration-2026-08-02-enlace-permanente.sql).
  expires_at    timestamptz,
  -- Cuándo se confirmó el número de WhatsApp desde este dispositivo.
  verified_at   timestamptz,
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now(),
  constraint storefront_sessions_datos_check check (
    token_hash ~ '^[0-9a-f]{64}$' and contact_phone ~ '^[0-9]{8,15}$'
    and (device_hash is null or device_hash ~ '^[0-9a-f]{64}$')
    and (device_hash is null) = (claimed_at is null)
  )
);
create unique index if not exists uq_storefront_sessions_token
  on public.storefront_sessions (token_hash);
create index if not exists idx_storefront_sessions_vigentes
  on public.storefront_sessions (expires_at) where revoked_at is null;

alter table public.orders
  add column if not exists customer_id uuid references public.customers(id) on delete set null,
  add column if not exists source text not null default 'whatsapp',
  add column if not exists address_id uuid references public.customer_addresses(id) on delete set null,
  add column if not exists fulfillment text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass and conname = 'orders_origen_check'
  ) then
    alter table public.orders add constraint orders_origen_check check (
      source in ('whatsapp', 'storefront', 'marketplace', 'manual')
      and (fulfillment is null or fulfillment in ('delivery', 'pickup', 'onsite'))
    );
  end if;
end;
$$;
create index if not exists idx_orders_cliente
  on public.orders (business_id, customer_id, created_at desc);

-- ── CITAS: precio, servicio y estado «atendida» ────────────
-- (migration-2026-08-02-cita-atendida-es-venta.sql)
-- ── 1. La cita sabe qué servicio es y cuánto vale ─────────────────────────
alter table public.bookings
  add column if not exists product_id uuid references public.products(id) on delete set null,
  add column if not exists price numeric(10,2);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bookings'::regclass and conname = 'bookings_precio_check'
  ) then
    alter table public.bookings add constraint bookings_precio_check check (
      price is null or (price >= 0 and price <= 99999)
    );
  end if;
end;
$$;

-- El servicio tiene que ser del MISMO negocio que la cita. Clave foránea
-- compuesta, como en el catálogo: que lo impida la base y no el que escriba
-- la próxima ruta.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bookings'::regclass and conname = 'fk_bookings_servicio_del_negocio'
  ) then
    alter table public.bookings
      add constraint fk_bookings_servicio_del_negocio
      foreign key (product_id, business_id)
      references public.products (id, business_id) on delete set null;
  end if;
end;
$$;

-- ── 2. «Atendida»: vino y se le atendió ───────────────────────────────────
alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check check (
  status in ('pending', 'confirmed', 'attended', 'cancelled', 'no_show')
);

-- ── 3. La venta sabe de qué cita salió ────────────────────────────────────
alter table public.sales
  add column if not exists booking_id uuid references public.bookings(id) on delete set null;

-- Una cita, una venta como máximo: lo mismo que protege a los pedidos de
-- duplicar dinero al marcar dos veces.
create unique index if not exists uq_sales_booking
  on public.sales (booking_id) where booking_id is not null;

-- ── 4. La conversión ──────────────────────────────────────────────────────
create or replace function public.crear_venta_desde_cita(
  p_business_id uuid,
  p_booking_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_booking public.bookings%rowtype;
  v_sale_id uuid;
  v_precio numeric(10,2);
  v_nombre text;
begin
  select * into v_booking
  from public.bookings
  where id = p_booking_id and business_id = p_business_id;
  if not found then
    return null;
  end if;

  select id into v_sale_id
  from public.sales
  where booking_id = p_booking_id and business_id = p_business_id;
  if found then
    return v_sale_id;
  end if;

  -- Solo cuenta lo atendido. Una cita pendiente, cancelada o a la que no vino
  -- nadie no es dinero. Igual que en pedidos y estadías: hoy quien decide es
  -- `set_booking_status`, pero esta función está concedida a service_role y no
  -- puede depender solo de su llamador.
  if v_booking.status is distinct from 'attended' then
    return null;
  end if;

  -- Sin precio no hay venta que registrar, y no es un error: una cita puede
  -- ser una consulta gratuita o el negocio puede cobrar aparte. Se atiende
  -- igual, simplemente no suma dinero.
  v_precio := coalesce(v_booking.price, 0);
  if v_precio <= 0 then
    return null;
  end if;

  v_nombre := coalesce(nullif(btrim(v_booking.service), ''), 'Servicio');

  insert into public.sales (
    business_id, booking_id, contact_phone, contact_name,
    total, status, source, sold_at
  ) values (
    p_business_id, p_booking_id, v_booking.contact_phone, v_booking.contact_name,
    v_precio, 'completada', 'cita', now()
  )
  returning id into v_sale_id;

  insert into public.sale_items (
    sale_id, business_id, product_id, product_name, quantity, unit_price, line_total
  ) values (
    v_sale_id, p_business_id, v_booking.product_id, v_nombre, 1, v_precio, v_precio
  );

  return v_sale_id;
end;
$$;

revoke all on function public.crear_venta_desde_cita(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.crear_venta_desde_cita(uuid, uuid) to service_role;

-- ── 5. Marcar atendida registra la venta, en una sola transacción ─────────
-- `p_price` existe porque la mayoría de las citas las agenda el BOT, y el bot
-- no pregunta precios. El dueño lo confirma al marcar «atendida», en la misma
-- llamada: si fuera un update aparte, una cita podría quedar atendida con el
-- precio a medio guardar.
create or replace function public.set_booking_status(
  p_business_id uuid,
  p_booking_id uuid,
  p_status text,
  p_price numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_booking public.bookings%rowtype;
begin
  if p_status not in ('pending', 'confirmed', 'attended', 'cancelled', 'no_show') then
    raise exception using errcode = '22023', message = 'Estado de cita inválido';
  end if;

  select * into v_booking
  from public.bookings
  where id = p_booking_id and business_id = p_business_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_booking.status = p_status then
    return jsonb_build_object('result', 'updated', 'booking', to_jsonb(v_booking));
  end if;

  -- Una cita cerrada no se reabre: se agenda otra. Igual que los pedidos, el
  -- camino va siempre hacia adelante para que el historial sea auditable.
  if v_booking.status in ('attended', 'cancelled', 'no_show') then
    return jsonb_build_object('result', 'invalid_transition', 'booking', to_jsonb(v_booking));
  end if;

  if p_price is not null and (p_price < 0 or p_price > 99999) then
    raise exception using errcode = '22023', message = 'El precio de la cita es inválido';
  end if;

  update public.bookings
  set status = p_status,
      price = coalesce(round(p_price, 2), price)
  where id = p_booking_id and business_id = p_business_id
  returning * into v_booking;

  if p_status = 'attended' then
    perform public.crear_venta_desde_cita(p_business_id, p_booking_id);
  end if;

  return jsonb_build_object('result', 'updated', 'booking', to_jsonb(v_booking));
end;
$$;

revoke all on function public.set_booking_status(uuid, uuid, text, numeric)
  from public, anon, authenticated;
grant execute on function public.set_booking_status(uuid, uuid, text, numeric) to service_role;


-- Un pedido entregado genera su venta: los reportes leen `sales`, así que sin
-- esto un pedido de la tienda se entregaba y no aparecía en ningún número
-- (migration-2026-08-02-pedido-entregado-es-venta.sql).
alter table public.sales
  add column if not exists order_id uuid references public.orders(id) on delete set null;
-- Un pedido, una venta como máximo: es lo que impide duplicar el dinero al
-- marcar «entregado» dos veces o al reintentar tras un fallo de red.
create unique index if not exists uq_sales_order
  on public.sales (order_id) where order_id is not null;
create index if not exists idx_sales_biz_order
  on public.sales (business_id, order_id);

-- Estados de reparto y de pago en instalaciones creadas antes de que
-- existieran (migration-2026-08-02-estados-pedido.sql y
-- migration-2026-08-05-pedidos-sin-duplicados.sql). Solo AÑADE valores
-- permitidos: ninguna fila existente puede quedar fuera del CHECK nuevo.
--
-- ⚠️ Esta es la definición que MANDA: va después de la del `create table`, así
-- que añadir un estado allí y olvidarlo aquí lo deja fuera igualmente.
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check check (
  status in (
    'pendiente', 'esperando_pago', 'pago_en_revision', 'confirmado', 'aceptado',
    'preparacion', 'listo_para_retiro', 'en_camino', 'completado',
    'cancelado', 'rechazado', 'expirado'
  )
);

-- Envío, método de pago y comprobante de la tienda
-- (migration-2026-08-02-tienda-pago-envio-marca.sql).
alter table public.orders
  add column if not exists shipping numeric(10,2) not null default 0,
  add column if not exists payment_method text,
  add column if not exists payment_proof_url text,
  -- Sin el identificador no se puede firmar el acceso temporal, y el
  -- comprobante volvería a ser público para siempre
  -- (migration-2026-08-05-comprobantes-privados.sql).
  add column if not exists payment_proof_public_id text;
alter table public.businesses
  add column if not exists delivery_fee numeric(10,2) not null default 0,
  add column if not exists brand_color text,
  add column if not exists logo_url text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass and conname = 'orders_pago_check'
  ) then
    -- `payment_method` queda nulo en los pedidos del bot, que no preguntan cómo
    -- se paga. La tarjeta no existe: la plataforma no cobra (regla #6).
    alter table public.orders add constraint orders_pago_check check (
      shipping >= 0
      and (payment_method is null or payment_method in ('transferencia', 'efectivo'))
    );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.businesses'::regclass and conname = 'businesses_tienda_check'
  ) then
    alter table public.businesses add constraint businesses_tienda_check check (
      delivery_fee >= 0 and delivery_fee <= 999
      and (brand_color is null or brand_color ~ '^#[0-9a-fA-F]{6}$')
    );
  end if;
  -- El logo acaba en un <img> de una app pública: solo https.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.businesses'::regclass and conname = 'businesses_logo_check'
  ) then
    alter table public.businesses add constraint businesses_logo_check check (
      logo_url is null or logo_url ~ '^https://'
    );
  end if;
end;
$$;
-- Pedidos en curso: los pide la alarma del panel cada 12 s por negocio y los
-- listará la bandeja de Pedidos. Parcial para no encarecer los ya cerrados.
create index if not exists idx_orders_activos
  on public.orders (business_id, created_at desc)
  where status in ('pendiente', 'confirmado', 'preparacion', 'en_camino');

create or replace function public.cleanup_storefront_sessions(p_days integer default 2)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
  v_days integer := greatest(coalesce(p_days, 2), 1);
begin
  with deleted as (
    delete from public.storefront_sessions as target
    -- `is not null` primero: comparar null con una fecha da null, no false,
    -- y el borrado dejaría de funcionar del todo sin avisar.
    where target.expires_at is not null
      and target.expires_at < now() - make_interval(days => v_days)
    returning 1
  )
  select count(*)::integer into v_deleted from deleted;
  return coalesce(v_deleted, 0);
end;
$$;
revoke all on function public.cleanup_storefront_sessions(integer)
  from public, anon, authenticated;

-- ── PEDIDOS DESDE LA MINI APP ──────────────────────────────
-- create_order_with_items valida el precio contra products.price, asi que
-- rechazaria un pedido con variantes. La tienda tiene su propia RPC: la app
-- manda ids y cantidades, jamas precios.
-- ── El ítem del pedido recuerda qué eligió el cliente ───────────────────────
-- Sin esto, el negocio ve "Pizza Pepperoni" y no sabe si era Personal o
-- Familiar, ni que llevaba queso extra.
alter table public.order_items
  add column if not exists variant_id uuid references public.product_variants(id) on delete set null,
  add column if not exists variant_name text,
  add column if not exists extras_names text[] not null default '{}'::text[],
  add column if not exists item_note text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_items'::regclass
      and conname = 'order_items_detalle_check'
  ) then
    alter table public.order_items
      add constraint order_items_detalle_check
      check (
        char_length(coalesce(variant_name, '')) <= 60
        and cardinality(extras_names) <= 20
        and char_length(coalesce(item_note, '')) <= 200
      );
  end if;
end;
$$;


-- ── Pedido de la tienda ─────────────────────────────────────────────────────
-- La firma cambió al añadir el método de pago: dejar viva la anterior haría
-- ambigua cualquier llamada.
drop function if exists public.create_storefront_order(
  uuid, uuid, text, text, uuid, text, jsonb, text
);

create or replace function public.create_storefront_order(
  p_business_id uuid,
  p_customer_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_address_id uuid,
  p_fulfillment text,
  p_items jsonb,
  p_notes text default null,
  p_payment_method text default null,
  p_idempotency_key text default null,
  p_scheduled_for timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business record;
  v_order_id uuid;
  v_item jsonb;
  v_product record;
  v_variant record;
  v_has_variant boolean;
  v_variant_ref uuid;
  v_variant_label text;
  v_product_id uuid;
  v_variant_id uuid;
  v_quantity integer;
  v_note text;
  v_extra_ids uuid[];
  v_extras_total numeric(10,2);
  v_extras_names text[];
  -- Lo elegido de los grupos de opciones, ya validado y con su precio de la
  -- base. Se acumula EN MEMORIA y por línea: una tabla auxiliar la pisarían
  -- dos pedidos simultáneos del mismo negocio.
  v_chosen jsonb;
  v_option jsonb;
  v_option_row record;
  v_options_total numeric(10,2);
  v_options_names text[];
  v_option_qty integer;
  v_group record;
  v_group_count integer;
  v_grupo_total numeric(10,2);
  v_product_category uuid;
  v_order_item_id uuid;
  v_unit_price numeric(10,2);
  v_line_total numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_shipping numeric(10,2) := 0;
  v_count integer := 0;
  v_clave text;
  v_existente public.orders%rowtype;
begin
  -- ── El negocio debe poder recibir pedidos por la tienda ──────────────────
  select id, active, suspended, storefront_enabled, takes_orders, delivery_fee
  into v_business
  from public.businesses
  where id = p_business_id
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'El negocio no existe';
  end if;
  if v_business.active is false or v_business.suspended is true then
    raise exception using errcode = '42501', message = 'El negocio no esta disponible';
  end if;
  if v_business.storefront_enabled is not true then
    raise exception using errcode = '42501', message = 'Este negocio no tiene tienda activada';
  end if;
  if v_business.takes_orders is not true then
    raise exception using errcode = '42501', message = 'Este negocio no recibe pedidos';
  end if;

  -- ── El mismo pedido dos veces es UN pedido ──────────────────────────────
  --
  -- Un doble toque en «Confirmar», o la app reintentando tras un corte de red,
  -- creaban dos pedidos idénticos: dos comandas en la cocina y un cliente que
  -- paga dos veces. La app manda una clave por intento de compra; si ya existe
  -- un pedido con ella, se DEVUELVE ese en vez de crear otro.
  v_clave := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_clave is not null then
    if char_length(v_clave) > 100 then
      raise exception using errcode = '22023', message = 'Clave de pedido invalida';
    end if;
    select * into v_existente
    from public.orders
    where business_id = p_business_id and idempotency_key = v_clave;
    if found then
      return jsonb_build_object(
        'id', v_existente.id,
        'subtotal', v_existente.subtotal,
        'shipping', v_existente.shipping,
        'total', v_existente.total,
        'items', (select count(*) from public.order_items oi where oi.order_id = v_existente.id),
        'repetido', true
      );
    end if;
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'El pedido no tiene productos';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception using errcode = '22023', message = 'El pedido tiene demasiados productos';
  end if;

  if p_fulfillment is not null and p_fulfillment not in ('delivery', 'pickup', 'onsite') then
    raise exception using errcode = '22023', message = 'Tipo de entrega invalido';
  end if;

  if p_payment_method is not null and p_payment_method not in ('transferencia', 'efectivo') then
    raise exception using errcode = '22023', message = 'Metodo de pago invalido';
  end if;

  -- La dirección, si viene, debe ser de ESE cliente y ESE negocio.
  if p_address_id is not null then
    if not exists (
      select 1 from public.customer_addresses
      where id = p_address_id
        and business_id = p_business_id
        and customer_id = p_customer_id
        and active = true
    ) then
      raise exception using errcode = '42501', message = 'La direccion no pertenece a este cliente';
    end if;
  end if;

  insert into public.orders (
    business_id, customer_id, contact_phone, contact_name,
    subtotal, discount, total, status, source, address_id, fulfillment,
    payment_method, idempotency_key, scheduled_for
  ) values (
    p_business_id, p_customer_id, btrim(p_contact_phone), nullif(btrim(coalesce(p_contact_name, '')), ''),
    0, 0, 0, 'pendiente', 'storefront', p_address_id, p_fulfillment,
    p_payment_method, v_clave, p_scheduled_for
  )
  returning id into v_order_id;

  -- ── Cada línea, con su precio resuelto en la base ────────────────────────
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_count := v_count + 1;
    v_product_id := nullif(v_item ->> 'product_id', '')::uuid;
    v_variant_id := nullif(v_item ->> 'variant_id', '')::uuid;
    v_quantity := coalesce((v_item ->> 'quantity')::integer, 0);
    v_note := left(nullif(btrim(coalesce(v_item ->> 'note', '')), ''), 200);

    if v_quantity < 1 or v_quantity > 99 then
      raise exception using errcode = '22023', message = 'La cantidad debe estar entre 1 y 99';
    end if;

    select id, name, price, price_sale, stock, category_id
    into v_product
    from public.products
    where id = v_product_id
      and business_id = p_business_id
      and active = true
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'El producto no pertenece al negocio';
    end if;
    if v_product.stock = 'agotado' then
      raise exception using errcode = '22023', message = format('%s esta agotado', v_product.name);
    end if;

    -- El precio sale de la variante si la hay; si no, del producto.
    -- Se usa una bandera y no `v_variant is null`: en PL/pgSQL un record sin
    -- asignar no se puede consultar, ni siquiera para comprobar si es nulo.
    v_has_variant := v_variant_id is not null;
    if v_has_variant then
      select id, name, price, price_sale, stock
      into v_variant
      from public.product_variants
      where id = v_variant_id
        and product_id = v_product_id
        and business_id = p_business_id
        and active = true
      for share;
      if not found then
        raise exception using errcode = '42501', message = 'La variante no pertenece a este producto';
      end if;
      if v_variant.stock = 'agotado' then
        raise exception using errcode = '22023', message = format('%s (%s) esta agotado', v_product.name, v_variant.name);
      end if;
      v_variant_ref := v_variant.id;
      v_variant_label := v_variant.name;
      v_unit_price := round(
        case when v_variant.price_sale > 0 then v_variant.price_sale else v_variant.price end, 2
      );
    else
      v_variant_ref := null;
      v_variant_label := null;
      v_unit_price := round(
        case when v_product.price_sale > 0 then v_product.price_sale else v_product.price end, 2
      );
    end if;

    if not (v_unit_price > 0) then
      raise exception using errcode = '22023', message = format('%s no tiene un precio valido', v_product.name);
    end if;

    -- ── Extras: pertenencia comprobada, precio de la base ──────────────────
    v_extras_total := 0;
    v_extras_names := '{}'::text[];
    if jsonb_typeof(v_item -> 'extra_ids') = 'array' then
      if jsonb_array_length(v_item -> 'extra_ids') > 20 then
        raise exception using errcode = '22023', message = 'Demasiados extras en un producto';
      end if;
      select array_agg(value::uuid) into v_extra_ids
      from jsonb_array_elements_text(v_item -> 'extra_ids');

      if v_extra_ids is not null and cardinality(v_extra_ids) > 0 then
        select coalesce(sum(m.price_delta), 0), coalesce(array_agg(m.name order by m.name), '{}')
        into v_extras_total, v_extras_names
        from public.menu_modifiers m
        where m.id = any(v_extra_ids)
          and m.business_id = p_business_id
          and m.active = true
          -- Del producto, o de una etiqueta que ese producto tenga.
          and (
            m.product_id = v_product_id
            or (m.product_id is null and m.category_tag is not null and exists (
              select 1 from public.products p2
              where p2.id = v_product_id
                and lower(m.category_tag) = any(select lower(unnest(coalesce(p2.tags, '{}'))))
            ))
          );

        if coalesce(cardinality(v_extras_names), 0) <> cardinality(v_extra_ids) then
          raise exception using errcode = '42501', message = 'Algun extra no corresponde a este producto';
        end if;
      end if;
    end if;

    -- ── Grupos de opciones: el motor con el que se arma un plato ──────────
    --
    -- Aquí se decide el dinero de verdad. La app manda id y cantidad; el
    -- recargo, el nombre y el derecho a estar en este producto salen de la
    -- base (regla inviolable #8).
    v_options_total := 0;
    v_options_names := '{}'::text[];
    v_chosen := '[]'::jsonb;
    v_product_category := v_product.category_id;

    if jsonb_typeof(v_item -> 'options') = 'array' then
      if jsonb_array_length(v_item -> 'options') > 30 then
        raise exception using errcode = '22023', message = 'Demasiadas opciones en un producto';
      end if;

      for v_option in select * from jsonb_array_elements(v_item -> 'options')
      loop
        v_option_qty := greatest(1, least(100, coalesce((v_option ->> 'quantity')::integer, 1)));

        -- La opción tiene que ser de este negocio Y de un grupo que aplique a
        -- ESTE producto: del producto, o de su categoría. Sin esto se podría
        -- abaratar una pizza mandando el id de una opción de otro plato.
        select o.id, o.name, o.price_adjustment, o.stock,
               og.id as group_id, og.name as group_name, og.selection_type
        into v_option_row
        from public.options o
        join public.option_groups og on og.id = o.option_group_id
        where o.id = nullif(v_option ->> 'option_id', '')::uuid
          and o.business_id = p_business_id
          and o.active = true
          and og.business_id = p_business_id
          and og.active = true
          and (
            og.product_id = v_product_id
            or (og.category_id is not null and og.category_id = v_product_category)
          );
        if not found then
          raise exception using errcode = '42501',
            message = format('Una opcion no corresponde a %s', v_product.name);
        end if;
        if v_option_row.stock = 'agotado' then
          raise exception using errcode = '22023',
            message = format('%s ya no esta disponible', v_option_row.name);
        end if;

        -- Fuera de los contadores, pedir tres veces la misma opción no
        -- significa nada y multiplicaría su recargo.
        if v_option_row.selection_type <> 'quantity' and v_option_qty <> 1 then
          raise exception using errcode = '22023',
            message = format('%s no se elige por cantidad', v_option_row.group_name);
        end if;
        -- Ni mandarla dos veces, que sería el mismo truco por otra puerta.
        if exists (
          select 1 from jsonb_array_elements(v_chosen) e
          where (e ->> 'option_id')::uuid = v_option_row.id
        ) then
          raise exception using errcode = '22023',
            message = format('%s viene repetida', v_option_row.name);
        end if;

        -- El importe ya NO se suma aquí: cada grupo se cobra según SU
        -- estrategia, y para eso hace falta ver todo lo elegido junto.
        v_options_names := v_options_names || (
          case when v_option_qty > 1
            then format('%s x%s', v_option_row.name, v_option_qty)
            else v_option_row.name
          end
        );
        v_chosen := v_chosen || jsonb_build_object(
          'option_id', v_option_row.id,
          'option_group_id', v_option_row.group_id,
          'option_group_name', v_option_row.group_name,
          'option_name', v_option_row.name,
          'quantity', v_option_qty,
          'unit_price_adjustment', v_option_row.price_adjustment
        );
      end loop;
    end if;

    -- ── Lo OBLIGATORIO se comprueba aquí, no en el navegador ──────────────
    --
    -- Un pedido sin el término de la carne llega a la cocina sin poder
    -- prepararse. La app ya lo impide, pero la app se puede saltar: esto es
    -- lo único que de verdad manda.
    for v_group in
      select og.id, og.name, og.selection_type, og.required,
             og.min_selectable, og.max_selectable,
             og.pricing_strategy, og.free_selections
      from public.option_groups og
      where og.business_id = p_business_id
        and og.active = true
        and (
          og.product_id = v_product_id
          or (og.category_id is not null and og.category_id = v_product_category)
        )
    loop
      -- En los contadores cuentan las PORCIONES; en el resto, cuántas se
      -- marcaron. Una parrillada de 4 se cumple con un corte pedido 4 veces.
      select coalesce(sum(
        case when v_group.selection_type = 'quantity'
          then (e ->> 'quantity')::integer else 1 end
      ), 0)
      into v_group_count
      from jsonb_array_elements(v_chosen) e
      where (e ->> 'option_group_id')::uuid = v_group.id;

      -- ── Lo que suma ESTE grupo, según cómo lo cobre el negocio ────────
      --
      -- Aquí vive la pizza mitad y mitad. Con `sum`, media Suprema ($10) y
      -- media Hawaiana ($9) costarían $19 —el doble de una pizza—; con
      -- `highest_selected` se cobra $10, que es como lo cobra el negocio.
      --
      -- Las estrategias con límite descuentan siempre las opciones MÁS CARAS,
      -- y nunca por orden de llegada: el mismo carrito tiene que costar lo
      -- mismo aunque se arme al revés.
      v_grupo_total := 0;
      if v_group_count > 0 then
        case coalesce(v_group.pricing_strategy, 'sum')
          when 'fixed' then v_grupo_total := 0;
          when 'included' then v_grupo_total := 0;
          when 'highest_selected' then
            -- El precio UNITARIO, sin multiplicar: dos medias pizzas son una.
            select max((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'lowest_selected' then
            select min((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'average' then
            select avg((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'included_up_to_limit' then
            -- Las N más caras van incluidas; el resto suma entero.
            select coalesce(sum(precio * cantidad), 0) into v_grupo_total
            from (
              select (e ->> 'unit_price_adjustment')::numeric as precio,
                     (e ->> 'quantity')::integer as cantidad,
                     row_number() over (
                       order by (e ->> 'unit_price_adjustment')::numeric desc
                     ) as puesto
              from jsonb_array_elements(v_chosen) e
              where (e ->> 'option_group_id')::uuid = v_group.id
            ) ordenadas
            where puesto > coalesce(v_group.free_selections, 0);
          when 'extra_after_limit' then
            -- Igual, pero el cupo se gasta en PORCIONES: una opción puede
            -- quedar a medias —dos bolas incluidas y la tercera cobrada—.
            select coalesce(sum(precio * greatest(0, cantidad - gratis)), 0)
            into v_grupo_total
            from (
              select precio, cantidad,
                     greatest(0, least(
                       cantidad,
                       coalesce(v_group.free_selections, 0) - coalesce(previas, 0)
                     )) as gratis
              from (
                select (e ->> 'unit_price_adjustment')::numeric as precio,
                       (e ->> 'quantity')::integer as cantidad,
                       sum((e ->> 'quantity')::integer) over (
                         order by (e ->> 'unit_price_adjustment')::numeric desc
                         rows between unbounded preceding and 1 preceding
                       ) as previas
                from jsonb_array_elements(v_chosen) e
                where (e ->> 'option_group_id')::uuid = v_group.id
              ) con_previas
            ) repartido;
          else
            -- `sum`: cada opción suma su recargo por sus porciones.
            select coalesce(sum(
              (e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer
            ), 0) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
        end case;
        v_options_total := v_options_total + round(coalesce(v_grupo_total, 0), 2);
      end if;

      if v_group_count < greatest(
        case when v_group.required then 1 else 0 end,
        coalesce(v_group.min_selectable, 0)
      ) then
        raise exception using errcode = '22023',
          message = format('Falta elegir %s en %s', v_group.name, v_product.name);
      end if;
      if v_group_count > coalesce(v_group.max_selectable, 1) then
        raise exception using errcode = '22023',
          message = format('Demasiadas opciones en %s', v_group.name);
      end if;
    end loop;

    -- Los recargos pueden ser NEGATIVOS («sin sopa −0.50»). Acumulados podrían
    -- dejar la línea en cero o por debajo, que es un plato regalado.
    v_unit_price := round(
      v_unit_price + coalesce(v_extras_total, 0) + coalesce(v_options_total, 0), 2
    );
    if not (v_unit_price > 0) then
      raise exception using errcode = '22023',
        message = format('%s quedaria sin precio valido con esas opciones', v_product.name);
    end if;

    v_line_total := round(v_unit_price * v_quantity, 2);
    v_subtotal := v_subtotal + v_line_total;

    -- `extras_names` es lo que el DUEÑO ve en su panel de pedidos. Las opciones
    -- entran ahí ADEMÁS de en `order_item_options`: si solo fueran a la tabla
    -- nueva, el pedido se vería sin lo que el cliente pidió.
    insert into public.order_items (
      order_id, business_id, product_id, product_name,
      variant_id, variant_name, extras_names, item_note,
      quantity, unit_price, line_total
    ) values (
      v_order_id, p_business_id, v_product.id, v_product.name,
      v_variant_ref, v_variant_label,
      coalesce(v_extras_names, '{}') || coalesce(v_options_names, '{}'), v_note,
      v_quantity, v_unit_price, v_line_total
    )
    returning id into v_order_item_id;

    -- La fotografía inmutable de lo elegido, con su precio congelado: si
    -- mañana cambia el recargo, el pedido de ayer sigue diciendo lo que costó.
    insert into public.order_item_options (
      business_id, order_item_id, option_group_id, option_id,
      option_group_name, option_name, quantity,
      unit_price_adjustment, total_price_adjustment
    )
    select p_business_id, v_order_item_id,
           (e ->> 'option_group_id')::uuid, (e ->> 'option_id')::uuid,
           e ->> 'option_group_name', e ->> 'option_name',
           (e ->> 'quantity')::integer,
           (e ->> 'unit_price_adjustment')::numeric,
           round((e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer, 2)
    from jsonb_array_elements(v_chosen) e;
  end loop;

  -- ── El envío: fijo del negocio, y SOLO si se lleva a domicilio ───────────
  -- Quien retira en el local no paga envío. El importe sale de la ficha del
  -- negocio, nunca del teléfono del cliente (regla inviolable #8).
  v_subtotal := round(v_subtotal, 2);
  if p_fulfillment = 'delivery' then
    v_shipping := round(coalesce(v_business.delivery_fee, 0), 2);
  end if;

  update public.orders
  set subtotal = v_subtotal,
      shipping = v_shipping,
      total = round(v_subtotal + v_shipping, 2)
  where id = v_order_id;

  return jsonb_build_object(
    'id', v_order_id,
    'subtotal', v_subtotal,
    'shipping', v_shipping,
    'total', round(v_subtotal + v_shipping, 2),
    'items', v_count
  );
end;
$$;

revoke all on function public.create_storefront_order(
  uuid, uuid, text, text, uuid, text, jsonb, text, text, text, timestamptz
) from public, anon, authenticated;

-- ── COMPROBANTE DE TRANSFERENCIA DE LA TIENDA ──────────────
-- Lo sube el CLIENTE desde la mini app, que no tiene JWT: su credencial es el
-- enlace. Por eso la pertenencia se comprueba con las tres cosas a la vez
-- —negocio, pedido y teléfono de la sesión—: sin esto, cualquiera con un id de
-- pedido ajeno podría colgarle una imagen.
-- La firma cambió al añadir el identificador de Cloudinary: dejar viva la
-- anterior haría ambigua cualquier llamada.
drop function if exists public.attach_storefront_payment_proof(uuid, uuid, text, text);

create or replace function public.attach_storefront_payment_proof(
  p_business_id uuid,
  p_order_id uuid,
  p_contact_phone text,
  p_url text,
  p_public_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
begin
  if nullif(btrim(coalesce(p_url, '')), '') is null or p_url !~ '^https://' then
    raise exception using errcode = '22023', message = 'El comprobante debe ser una URL https';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
    and business_id = p_business_id
    and contact_phone = btrim(p_contact_phone)
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- Un pedido ya cerrado no admite comprobante: o se pagó, o se anuló.
  if v_order.status in ('completado', 'cancelado', 'expirado') then
    return jsonb_build_object('result', 'invalid_state', 'status', v_order.status);
  end if;

  -- Se guarda el identificador ADEMÁS de la URL: sin él no se puede firmar el
  -- acceso temporal, y el comprobante volvería a ser público para siempre.
  --
  -- Y el pedido pasa a REVISIÓN. Antes se quedaba en «pendiente» con una
  -- imagen colgada y nada que avisara al dueño de que había un pago esperando
  -- a que alguien lo mirara. Solo se mueve desde los estados en los que aún se
  -- está esperando el pago: si el dueño ya lo confirmó a mano, mandar otro
  -- comprobante no puede echarlo atrás.
  update public.orders
  set payment_proof_url = p_url,
      payment_proof_public_id = p_public_id,
      status = case
        when v_order.status in ('pendiente', 'esperando_pago') then 'pago_en_revision'
        else v_order.status
      end,
      updated_at = now()
  where id = p_order_id and business_id = p_business_id;

  if v_order.status in ('pendiente', 'esperando_pago') then
    insert into public.order_events (business_id, order_id, from_status, to_status, note)
    values (p_business_id, p_order_id, v_order.status, 'pago_en_revision',
            'El cliente subió su comprobante');
  end if;

  return jsonb_build_object('result', 'updated');
end;
$$;

revoke all on function public.attach_storefront_payment_proof(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.attach_storefront_payment_proof(uuid, uuid, text, text, text)
  to service_role;

-- ── REGISTRO DE ERRORES DE PLATAFORMA ──────────────────────
-- La huella llega calculada desde Node y NO se genera con digest() aquí: esa
-- función fuera del search_path fue justamente lo que tumbó el canal de entrada
-- cinco días en julio de 2026.
create or replace function public.record_platform_error(
  p_business_id uuid,
  p_category text,
  p_code text,
  p_message text,
  p_context jsonb,
  p_fingerprint text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_message text;
  v_context jsonb;
begin
  if p_category not in ('canal', 'ia', 'envio', 'servidor') then
    raise exception using errcode = '22023', message = 'Categoria de error invalida';
  end if;
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Huella de error invalida';
  end if;

  v_message := left(coalesce(nullif(btrim(p_message), ''), 'Error sin detalle'), 2000);
  v_context := case
    when jsonb_typeof(p_context) = 'object' and pg_column_size(p_context) <= 8192
      then p_context
    else '{}'::jsonb
  end;

  -- Upsert atómico. Se resuelve con `on conflict` sobre los índices parciales en
  -- lugar de capturar excepciones: así el registro nunca deja una transacción a
  -- medias, ni siquiera si dos errores idénticos llegan a la vez.
  if p_business_id is null then
    insert into public.platform_errors (
      business_id, category, code, message, context, fingerprint
    ) values (
      null, p_category, left(p_code, 120), v_message, v_context, p_fingerprint
    )
    on conflict (fingerprint) where business_id is null do update
    set occurrences = public.platform_errors.occurrences + 1,
        last_seen_at = now(),
        code = excluded.code,
        message = excluded.message,
        context = excluded.context
    returning id into v_id;
  else
    insert into public.platform_errors (
      business_id, category, code, message, context, fingerprint
    ) values (
      p_business_id, p_category, left(p_code, 120), v_message, v_context, p_fingerprint
    )
    on conflict (business_id, fingerprint) where business_id is not null do update
    set occurrences = public.platform_errors.occurrences + 1,
        last_seen_at = now(),
        code = excluded.code,
        message = excluded.message,
        context = excluded.context
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

create or replace function public.cleanup_platform_errors(p_days integer default 30)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
  v_days integer := greatest(coalesce(p_days, 30), 1);
begin
  with deleted as (
    delete from public.platform_errors as target
    where target.last_seen_at < now() - make_interval(days => v_days)
    returning 1
  )
  select count(*)::integer into v_deleted from deleted;
  return coalesce(v_deleted, 0);
end;
$$;

revoke all on function public.record_platform_error(uuid, text, text, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.cleanup_platform_errors(integer)
  from public, anon, authenticated;

-- ── ROW LEVEL SECURITY (RLS) ───────────────────────────────
-- RLS ACTIVADO en todas las tablas. El backend usa la SERVICE KEY
-- (la bypassa); el aislamiento real lo refuerza el filtrado por
-- business_id en db.js. La anon key del frontend queda BLOQUEADA
-- (no lee datos directo) → por eso el frontend usa polling vía API.
alter table businesses            enable row level security;
alter table business_channel_identifiers enable row level security;
alter table client_users          enable row level security;
alter table products              enable row level security;
alter table menu_modifiers        enable row level security;
alter table bot_policies          enable row level security;
alter table conversation_history  enable row level security;
alter table conversation_sessions enable row level security;
alter table conversation_tags     enable row level security;
alter table business_schedule     enable row level security;
alter table bookings              enable row level security;
alter table billing               enable row level security;
alter table server_settings       enable row level security;
alter table schema_migrations     enable row level security;
alter table sales                 enable row level security;
alter table sale_items            enable row level security;
alter table product_consultations enable row level security;
alter table ai_gaps               enable row level security;
alter table orders                enable row level security;
alter table order_items           enable row level security;
alter table webhook_inbound_events enable row level security;
alter table platform_errors       enable row level security;
alter table product_categories    enable row level security;
alter table product_variants      enable row level security;
alter table business_bank_accounts enable row level security;
alter table customers             enable row level security;
alter table business_customers    enable row level security;
alter table customer_addresses    enable row level security;
alter table storefront_sessions   enable row level security;

revoke all on table menu_modifiers
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table menu_modifiers
  to service_role;

revoke all on table webhook_inbound_events from public, anon, authenticated;
grant select, insert, update, delete on table webhook_inbound_events
  to service_role;

-- ============================================================
-- NOTA: el archivo migration-integraciones.sql quedó OBSOLETO.
-- Este schema.sql es la referencia única y actual del esquema.
-- ============================================================
-- ============================================================
-- MÓDULO DE HOSPEDAJE (inventario, cotizaciones y holds)
-- Mantenido también como migración incremental en migration-hospedaje.sql.
-- ============================================================
-- Módulo transaccional de hospedaje: inventario agregado por tipo de habitación,
-- cotizaciones oficiales y holds pendientes de confirmación del dueño.
-- Es aditivo e idempotente. No reutiliza la agenda simple (`bookings`).

begin;

create extension if not exists btree_gist;

alter table public.businesses
  add column if not exists lodging_enabled boolean not null default false;

create table if not exists public.lodging_settings (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses(id) on delete cascade,
  currency              text not null default 'USD'
                        check (currency in ('USD','EUR','COP','PEN','MXN','BRL','CLP','ARS')),
  tax_rate              numeric(7,6) not null default 0
                        check (tax_rate between 0 and 1),
  service_fee           numeric(12,2) not null default 0
                        check (service_fee >= 0),
  prices_include_tax    boolean not null default true,
  check_in_time         time not null default '15:00',
  check_out_time        time not null default '11:00',
  quote_expiry_minutes  integer not null default 15
                        check (quote_expiry_minutes between 1 and 1440),
  hold_minutes          integer not null default 45
                        check (hold_minutes between 5 and 1440),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (business_id),
  unique (business_id, id)
);

create table if not exists public.lodging_room_types (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses(id) on delete cascade,
  name              text not null check (char_length(btrim(name)) between 1 and 120),
  description       text,
  amenities         text[] not null default '{}',
  media_urls       text[] not null default '{}',
  total_units       integer not null check (total_units between 1 and 10000),
  base_occupancy    integer not null default 1
                    check (base_occupancy between 1 and 100),
  max_guests        integer not null default 1
                    check (max_guests between 1 and 100),
  pricing_model     text not null default 'per_unit'
                    check (pricing_model in (
                      'per_unit', 'per_person', 'base_plus_extra', 'manual'
                    )),
  base_rate         numeric(12,2),
  weekend_rate      numeric(12,2),
  extra_adult_rate  numeric(12,2) not null default 0,
  child_rate        numeric(12,2) not null default 0,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (business_id, id),
  constraint lodging_room_types_capacity_check
    check (max_guests >= base_occupancy),
  constraint lodging_room_types_rates_check check (
    (pricing_model = 'manual' and base_rate is null)
    or (pricing_model <> 'manual' and base_rate > 0)
  ),
  constraint lodging_room_types_optional_rates_check check (
    (weekend_rate is null or weekend_rate > 0)
    and extra_adult_rate >= 0
    and child_rate >= 0
  )
);

create table if not exists public.lodging_rate_overrides (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses(id) on delete cascade,
  room_type_id      uuid not null,
  rate_date         date not null,
  base_rate         numeric(12,2),
  extra_adult_rate  numeric(12,2),
  child_rate        numeric(12,2),
  closed            boolean not null default false,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (business_id, room_type_id)
    references public.lodging_room_types(business_id, id) on delete cascade,
  unique (business_id, room_type_id, rate_date),
  constraint lodging_rate_overrides_rates_check check (
    (base_rate is null or base_rate > 0)
    and (extra_adult_rate is null or extra_adult_rate >= 0)
    and (child_rate is null or child_rate >= 0)
  )
);

create table if not exists public.lodging_quotes (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses(id) on delete cascade,
  contact_phone         text not null check (char_length(btrim(contact_phone)) between 1 and 80),
  contact_name          text,
  check_in              date not null,
  check_out             date not null,
  check_in_time         time not null,
  check_out_time        time not null,
  adults                integer not null check (adults between 1 and 500),
  children              integer not null default 0 check (children between 0 and 500),
  rooms_count           integer not null default 1 check (rooms_count between 1 and 100),
  nights                integer not null check (nights between 1 and 366),
  currency              text not null
                        check (currency in ('USD','EUR','COP','PEN','MXN','BRL','CLP','ARS')),
  options               jsonb not null default '[]'::jsonb
                        check (jsonb_typeof(options) = 'array'),
  status                text not null default 'quoted'
                        check (status in ('quoted', 'accepted', 'expired')),
  expires_at            timestamptz not null,
  accepted_at           timestamptz,
  idempotency_key_hash  text
                        check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  created_at            timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, idempotency_key_hash),
  constraint lodging_quotes_dates_check check (check_out > check_in),
  -- `nights check (...)` ya recibe automáticamente el nombre
  -- lodging_quotes_nights_check. Usa otro nombre para la relación con fechas.
  constraint lodging_quotes_nights_match_dates_check
    check (nights = check_out - check_in)
);

create table if not exists public.lodging_requests (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses(id) on delete cascade,
  quote_id              uuid not null,
  room_type_id          uuid not null,
  room_type_name        text not null,
  contact_phone         text not null check (char_length(btrim(contact_phone)) between 1 and 80),
  contact_name          text,
  check_in              date not null,
  check_out             date not null,
  check_in_time         time not null,
  check_out_time        time not null,
  adults                integer not null check (adults between 1 and 500),
  children              integer not null default 0 check (children between 0 and 500),
  units_required        integer not null check (units_required between 1 and 100),
  nights                integer not null check (nights between 1 and 366),
  pricing_model         text not null check (pricing_model in (
                          'per_unit', 'per_person', 'base_plus_extra'
                        )),
  subtotal              numeric(12,2) not null check (subtotal >= 0),
  tax                   numeric(12,2) not null default 0 check (tax >= 0),
  fees                  numeric(12,2) not null default 0 check (fees >= 0),
  total                 numeric(12,2) not null check (total >= 0),
  currency              text not null
                        check (currency in ('USD','EUR','COP','PEN','MXN','BRL','CLP','ARS')),
  nightly_breakdown     jsonb not null default '[]'::jsonb
                        check (jsonb_typeof(nightly_breakdown) = 'array'),
  status                text not null default 'pending_owner'
                        check (status in (
                          'pending_owner', 'confirmed', 'rejected', 'cancelled', 'expired'
                        )),
  expires_at            timestamptz,
  confirmed_at          timestamptz,
  released_at           timestamptz,
  idempotency_key_hash  text not null
                        check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  foreign key (business_id, quote_id)
    references public.lodging_quotes(business_id, id) on delete restrict,
  foreign key (business_id, room_type_id)
    references public.lodging_room_types(business_id, id) on delete restrict,
  unique (business_id, id),
  unique (business_id, quote_id),
  unique (business_id, idempotency_key_hash),
  constraint lodging_requests_dates_check check (check_out > check_in),
  constraint lodging_requests_nights_match_dates_check
    check (nights = check_out - check_in),
  -- La columna `total check (total >= 0)` ya ocupa el nombre automático
  -- lodging_requests_total_check.
  constraint lodging_requests_total_components_check check (
    total = round(subtotal + fees, 2)
    or total = round(subtotal + tax + fees, 2)
  )
);

create table if not exists public.lodging_blocks (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  room_type_id  uuid not null,
  request_id    uuid,
  kind          text not null check (kind in ('request', 'manual', 'external', 'maintenance')),
  start_date    date not null,
  end_date      date not null,
  quantity      integer not null check (quantity between 1 and 10000),
  notes         text,
  released_at   timestamptz,
  stay_range    daterange generated always as (
                  daterange(start_date, end_date, '[)')
                ) stored,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (business_id, room_type_id)
    references public.lodging_room_types(business_id, id) on delete restrict,
  foreign key (business_id, request_id)
    references public.lodging_requests(business_id, id) on delete cascade,
  unique (business_id, id),
  unique (business_id, request_id),
  constraint lodging_blocks_dates_check check (end_date > start_date),
  constraint lodging_blocks_request_kind_check check (
    (kind = 'request' and request_id is not null)
    or (kind <> 'request' and request_id is null)
  )
);

create unique index if not exists uq_lodging_room_types_business_name
  on public.lodging_room_types (business_id, lower(name));
create index if not exists idx_lodging_room_types_business_active
  on public.lodging_room_types (business_id, active);
create index if not exists idx_lodging_rate_overrides_lookup
  on public.lodging_rate_overrides (business_id, room_type_id, rate_date);
create index if not exists idx_lodging_quotes_business_created
  on public.lodging_quotes (business_id, created_at desc);
create index if not exists idx_lodging_quotes_business_contact
  on public.lodging_quotes (business_id, contact_phone, created_at desc);
create index if not exists idx_lodging_requests_business_status_dates
  on public.lodging_requests (business_id, status, check_in, check_out);
create index if not exists idx_lodging_requests_business_contact
  on public.lodging_requests (business_id, contact_phone, created_at desc);
create index if not exists idx_lodging_requests_expiry
  on public.lodging_requests (expires_at)
  where status = 'pending_owner';
create index if not exists idx_lodging_blocks_business_request
  on public.lodging_blocks (business_id, request_id);
create index if not exists idx_lodging_blocks_active_lookup
  on public.lodging_blocks (business_id, room_type_id, start_date, end_date)
  where released_at is null;
create index if not exists idx_lodging_blocks_stay_range
  on public.lodging_blocks using gist (business_id, room_type_id, stay_range)
  where released_at is null;

create or replace function public.lodging_request_to_json(
  p_request public.lodging_requests
)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select (to_jsonb(p_request) - 'idempotency_key_hash')
    || jsonb_build_object(
      'check_in_time', to_char(p_request.check_in_time, 'HH24:MI'),
      'check_out_time', to_char(p_request.check_out_time, 'HH24:MI')
    );
$$;

-- Garantía física del inventario agregado. Cualquier INSERT/UPDATE directo,
-- incluso con service_role, toma el mismo lock que las RPC y no puede superar
-- total_units en ninguna noche del rango.
create or replace function public.enforce_lodging_block_capacity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_total_units integer;
  v_request public.lodging_requests%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.business_id::text || ':lodging', 0));

  if tg_op = 'UPDATE'
     and old.kind = 'request'
     and (
       new.kind <> old.kind
       or new.request_id is distinct from old.request_id
       or new.business_id is distinct from old.business_id
       or new.room_type_id is distinct from old.room_type_id
       or new.start_date is distinct from old.start_date
       or new.end_date is distinct from old.end_date
       or new.quantity is distinct from old.quantity
     ) then
    raise exception using
      errcode = '42501',
      message = 'La identidad de un bloqueo de solicitud es inmutable';
  end if;

  if new.released_at is not null then
    if new.kind = 'request' then
      select request.*
      into v_request
      from public.lodging_requests as request
      where request.business_id = new.business_id
        and request.id = new.request_id
      for share;

      if not found or v_request.status not in (
        'rejected', 'cancelled', 'expired'
      ) then
        raise exception using
          errcode = '42501',
          message = 'Un bloqueo de solicitud solo se libera mediante el estado de la solicitud';
      end if;
    end if;
    return new;
  end if;

  select room_type.total_units
  into v_total_units
  from public.lodging_room_types as room_type
  where room_type.business_id = new.business_id
    and room_type.id = new.room_type_id
  for share;

  if not found then
    raise exception using errcode = '23503', message = 'El tipo de habitación no pertenece al negocio';
  end if;

  if new.kind = 'request' then
    select request.*
    into v_request
    from public.lodging_requests as request
    where request.business_id = new.business_id
      and request.id = new.request_id
      and request.room_type_id = new.room_type_id
      and request.check_in = new.start_date
      and request.check_out = new.end_date
      and request.units_required = new.quantity
    for share;

    if not found or not (
      v_request.status = 'confirmed'
      or (
        v_request.status = 'pending_owner'
        and v_request.expires_at is not null
        and v_request.expires_at > now()
      )
    ) then
      raise exception using errcode = '23514', message = 'El bloqueo no coincide con una solicitud activa';
    end if;
  end if;

  if exists (
    select 1
    from generate_series(new.start_date, new.end_date - 1, interval '1 day') as occupied_day
    where coalesce((
      select sum(block.quantity)
      from public.lodging_blocks as block
      left join public.lodging_requests as request
        on request.business_id = block.business_id
       and request.id = block.request_id
      where block.business_id = new.business_id
        and block.room_type_id = new.room_type_id
        and block.id <> new.id
        and block.released_at is null
        and block.start_date <= occupied_day::date
        and block.end_date > occupied_day::date
        and (
          block.request_id is null
          or request.status = 'confirmed'
          or (
            request.status = 'pending_owner'
            and request.expires_at is not null
            and request.expires_at > now()
          )
        )
    ), 0) + new.quantity > v_total_units
  ) then
    raise exception using errcode = '23P01', message = 'No hay inventario suficiente para todo el rango';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.set_lodging_request_status(
  p_business_id uuid,
  p_request_id uuid,
  p_status text
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_request public.lodging_requests%rowtype;
  v_release boolean;
begin
  if p_business_id is null or p_request_id is null then
    raise exception using errcode = '22023', message = 'Negocio y solicitud son obligatorios';
  end if;
  if p_status not in (
    'confirmed', 'rejected', 'cancelled', 'expired'
  ) then
    return jsonb_build_object('result', 'invalid_transition', 'request', null);
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text || ':lodging', 0));
  perform public.expire_lodging_holds(p_business_id);

  select request.*
  into v_request
  from public.lodging_requests as request
  where request.business_id = p_business_id
    and request.id = p_request_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found', 'request', null);
  end if;
  if v_request.status = 'expired' then
    return jsonb_build_object(
      'result', 'expired',
      'changed', false,
      'request', public.lodging_request_to_json(v_request)
    );
  end if;
  if v_request.status = p_status then
    return jsonb_build_object(
      'result', 'unchanged',
      'changed', false,
      'request', public.lodging_request_to_json(v_request)
    );
  end if;

  if not (
    (v_request.status = 'pending_owner' and p_status in (
      'confirmed', 'rejected', 'cancelled', 'expired'
    ))
    or (v_request.status = 'confirmed' and p_status = 'cancelled')
  ) then
    return jsonb_build_object(
      'result', 'invalid_transition',
      'request', public.lodging_request_to_json(v_request)
    );
  end if;

  v_release := p_status in (
    'rejected', 'cancelled', 'expired'
  );

  update public.lodging_requests as request
  set status = p_status,
      expires_at = case when p_status = 'confirmed' then null else request.expires_at end,
      confirmed_at = case
        when p_status = 'confirmed' then coalesce(request.confirmed_at, now())
        else request.confirmed_at
      end,
      released_at = case
        when v_release then coalesce(request.released_at, now())
        else request.released_at
      end,
      updated_at = now()
  where request.business_id = p_business_id
    and request.id = p_request_id
  returning * into v_request;

  if v_release then
    update public.lodging_blocks as block
    set released_at = coalesce(block.released_at, now()),
        updated_at = now()
    where block.business_id = p_business_id
      and block.request_id = p_request_id
      and block.released_at is null;
  end if;

  return jsonb_build_object(
    'result', 'updated',
    'changed', true,
    'request', public.lodging_request_to_json(v_request)
  );
end;
$$;

create or replace function public.upsert_lodging_block_if_available(
  p_business_id uuid,
  p_room_type_id uuid,
  p_kind text,
  p_start_date date,
  p_end_date date,
  p_quantity integer,
  p_notes text default null,
  p_block_id uuid default null
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_block public.lodging_blocks%rowtype;
begin
  if p_business_id is null or p_room_type_id is null then
    raise exception using errcode = '22023', message = 'Negocio y tipo de habitación son obligatorios';
  end if;
  if p_kind not in ('manual', 'external', 'maintenance') or p_kind is null then
    return jsonb_build_object('result', 'forbidden', 'block', null);
  end if;
  if p_start_date is null or p_end_date is null or p_end_date <= p_start_date then
    raise exception using errcode = '22023', message = 'El rango del bloqueo es inválido';
  end if;
  if coalesce(p_quantity, 0) not between 1 and 10000 then
    raise exception using errcode = '22023', message = 'La cantidad del bloqueo es inválida';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text || ':lodging', 0));
  perform public.expire_lodging_holds(p_business_id);

  if not exists (
    select 1
    from public.lodging_room_types as room_type
    where room_type.business_id = p_business_id
      and room_type.id = p_room_type_id
  ) then
    return jsonb_build_object('result', 'not_found', 'block', null);
  end if;

  if p_block_id is null then
    insert into public.lodging_blocks (
      business_id, room_type_id, request_id, kind,
      start_date, end_date, quantity, notes
    ) values (
      p_business_id, p_room_type_id, null, p_kind,
      p_start_date, p_end_date, p_quantity, nullif(btrim(p_notes), '')
    ) returning * into v_block;

    return jsonb_build_object('result', 'created', 'block', to_jsonb(v_block));
  end if;

  select block.*
  into v_block
  from public.lodging_blocks as block
  where block.business_id = p_business_id
    and block.id = p_block_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found', 'block', null);
  end if;
  if v_block.kind = 'request' or v_block.request_id is not null then
    return jsonb_build_object('result', 'forbidden', 'block', null);
  end if;

  update public.lodging_blocks as block
  set room_type_id = p_room_type_id,
      kind = p_kind,
      start_date = p_start_date,
      end_date = p_end_date,
      quantity = p_quantity,
      notes = nullif(btrim(p_notes), ''),
      released_at = null,
      updated_at = now()
  where block.business_id = p_business_id
    and block.id = p_block_id
    and block.request_id is null
    and block.kind <> 'request'
  returning * into v_block;

  return jsonb_build_object('result', 'updated', 'block', to_jsonb(v_block));
exception
  when exclusion_violation then
    return jsonb_build_object('result', 'unavailable', 'block', null);
end;
$$;

create or replace function public.release_lodging_block(
  p_business_id uuid,
  p_block_id uuid
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_block public.lodging_blocks%rowtype;
begin
  if p_business_id is null or p_block_id is null then
    raise exception using errcode = '22023', message = 'Negocio y bloqueo son obligatorios';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text || ':lodging', 0));

  select block.*
  into v_block
  from public.lodging_blocks as block
  where block.business_id = p_business_id
    and block.id = p_block_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found', 'block', null);
  end if;
  if v_block.kind = 'request' or v_block.request_id is not null then
    return jsonb_build_object('result', 'forbidden', 'block', null);
  end if;

  update public.lodging_blocks as block
  set released_at = coalesce(block.released_at, now()),
      updated_at = now()
  where block.business_id = p_business_id
    and block.id = p_block_id
    and block.request_id is null
    and block.kind <> 'request'
  returning * into v_block;

  return jsonb_build_object('result', 'released', 'block', to_jsonb(v_block));
end;
$$;


create or replace function public.create_lodging_request_if_available(
  p_business_id uuid,
  p_quote_id uuid,
  p_room_type_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_idempotency_key text,
  p_notes text default null
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_business public.businesses%rowtype;
  v_settings public.lodging_settings%rowtype;
  v_quote public.lodging_quotes%rowtype;
  v_room_type public.lodging_room_types%rowtype;
  v_override public.lodging_rate_overrides%rowtype;
  v_request public.lodging_requests%rowtype;
  v_existing_request public.lodging_requests%rowtype;
  v_block public.lodging_blocks%rowtype;
  v_snapshot jsonb;
  v_breakdown jsonb := '[]'::jsonb;
  v_idempotency_hash text;
  v_total_guests integer;
  v_units_required integer;
  v_available_units integer;
  v_stay_date date;
  v_has_override boolean;
  v_closed boolean;
  v_effective_base numeric(12,2);
  v_effective_extra numeric(12,2);
  v_effective_child numeric(12,2);
  v_extra_adults integer;
  v_line_total numeric(12,2);
  v_subtotal numeric(12,2) := 0;
  v_tax numeric(12,2);
  v_fees numeric(12,2);
  v_total numeric(12,2);
begin
  if p_business_id is null or p_quote_id is null or p_room_type_id is null then
    raise exception using errcode = '22023', message = 'Negocio, cotización y tipo de habitación son obligatorios';
  end if;
  if nullif(btrim(p_contact_phone), '') is null
     or char_length(btrim(p_contact_phone)) > 80 then
    raise exception using errcode = '22023', message = 'El contacto es obligatorio';
  end if;
  if nullif(p_idempotency_key, '') is null
     or char_length(p_idempotency_key) not between 1 and 512 then
    raise exception using errcode = '22023', message = 'La clave de idempotencia es obligatoria';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text || ':lodging', 0));

  select business.*
  into v_business
  from public.businesses as business
  where business.id = p_business_id
  for share;

  if not found then
    raise exception using errcode = '23503', message = 'El negocio no existe';
  end if;
  if v_business.lodging_enabled is distinct from true
     or v_business.active is distinct from true
     or v_business.suspended is true then
    raise exception using errcode = '42501', message = 'El módulo de hospedaje no está habilitado';
  end if;

  insert into public.lodging_settings (business_id)
  values (p_business_id)
  on conflict (business_id) do nothing;

  select settings.*
  into v_settings
  from public.lodging_settings as settings
  where settings.business_id = p_business_id
  for share;

  perform public.expire_lodging_holds(p_business_id);

  v_idempotency_hash := encode(
    sha256(convert_to(p_idempotency_key, 'UTF8')),
    'hex'
  );

  select request.*
  into v_existing_request
  from public.lodging_requests as request
  where request.business_id = p_business_id
    and request.idempotency_key_hash = v_idempotency_hash;

  if found then
    if v_existing_request.quote_id <> p_quote_id
       or v_existing_request.room_type_id <> p_room_type_id
       or v_existing_request.contact_phone <> btrim(p_contact_phone) then
      raise exception using errcode = '22023', message = 'La clave de idempotencia ya fue usada con otros datos';
    end if;
    if v_existing_request.status = 'pending_owner' then
      return jsonb_build_object(
        'result', 'duplicate',
        'request', public.lodging_request_to_json(v_existing_request)
      );
    end if;
    if v_existing_request.status = 'expired' then
      return jsonb_build_object('result', 'quote_expired', 'request', null);
    end if;
    return jsonb_build_object(
      'result', 'invalid_transition',
      'request', public.lodging_request_to_json(v_existing_request)
    );
  end if;

  select quote.*
  into v_quote
  from public.lodging_quotes as quote
  where quote.business_id = p_business_id
    and quote.id = p_quote_id
  for update;

  if not found
     or v_quote.status = 'expired'
     or v_quote.expires_at <= now() then
    return jsonb_build_object('result', 'quote_expired', 'request', null);
  end if;
  if v_quote.contact_phone <> btrim(p_contact_phone)
     or (
       nullif(btrim(p_contact_name), '') is not null
       and v_quote.contact_name is not null
       and nullif(btrim(p_contact_name), '') <> v_quote.contact_name
     ) then
    raise exception using errcode = '42501', message = 'La cotización no pertenece al contacto';
  end if;

  if v_quote.status = 'accepted' then
    select request.*
    into v_existing_request
    from public.lodging_requests as request
    where request.business_id = p_business_id
      and request.quote_id = p_quote_id;

    if found and v_existing_request.status = 'pending_owner' then
      return jsonb_build_object(
        'result', 'duplicate',
        'request', public.lodging_request_to_json(v_existing_request)
      );
    end if;
    if found and v_existing_request.status = 'expired' then
      return jsonb_build_object('result', 'quote_expired', 'request', null);
    end if;
    return jsonb_build_object('result', 'invalid_transition', 'request', null);
  end if;

  select option_value
  into v_snapshot
  from jsonb_array_elements(v_quote.options) as option_value
  where option_value ->> 'room_type_id' = p_room_type_id::text
  limit 1;

  if not found then
    return jsonb_build_object('result', 'room_type_not_found', 'request', null);
  end if;

  select room_type.*
  into v_room_type
  from public.lodging_room_types as room_type
  where room_type.business_id = p_business_id
    and room_type.id = p_room_type_id
    and room_type.active is true
  for share;

  if not found then
    return jsonb_build_object('result', 'room_type_not_found', 'request', null);
  end if;
  if v_room_type.pricing_model = 'manual' then
    return jsonb_build_object('result', 'manual_quote', 'request', null);
  end if;

  v_total_guests := v_quote.adults + v_quote.children;
  v_units_required := greatest(
    v_quote.rooms_count,
    ceil(v_total_guests::numeric / v_room_type.max_guests)::integer
  );

  v_closed := exists (
    select 1
    from public.lodging_rate_overrides as override
    where override.business_id = p_business_id
      and override.room_type_id = p_room_type_id
      and override.rate_date >= v_quote.check_in
      and override.rate_date < v_quote.check_out
      and override.closed is true
  );
  if v_closed then
    return jsonb_build_object('result', 'unavailable', 'request', null);
  end if;

  select coalesce(min(
    v_room_type.total_units - coalesce((
      select sum(block.quantity)
      from public.lodging_blocks as block
      left join public.lodging_requests as request
        on request.business_id = block.business_id
       and request.id = block.request_id
      where block.business_id = p_business_id
        and block.room_type_id = p_room_type_id
        and block.released_at is null
        and block.start_date <= occupied_day::date
        and block.end_date > occupied_day::date
        and (
          block.request_id is null
          or request.status = 'confirmed'
          or (
            request.status = 'pending_owner'
            and request.expires_at is not null
            and request.expires_at > now()
          )
        )
    ), 0)
  ), v_room_type.total_units)::integer
  into v_available_units
  from generate_series(
    v_quote.check_in,
    v_quote.check_out - 1,
    interval '1 day'
  ) as occupied_day;

  if v_units_required > v_room_type.total_units
     or v_available_units < v_units_required then
    return jsonb_build_object('result', 'unavailable', 'request', null);
  end if;

  for v_stay_date in
    select day_value::date
    from generate_series(
      v_quote.check_in,
      v_quote.check_out - 1,
      interval '1 day'
    ) as day_value
  loop
    v_has_override := false;
    select override.*
    into v_override
    from public.lodging_rate_overrides as override
    where override.business_id = p_business_id
      and override.room_type_id = p_room_type_id
      and override.rate_date = v_stay_date;
    v_has_override := found;

    v_effective_base := case
      when v_has_override and v_override.base_rate is not null
        then v_override.base_rate
      when extract(isodow from v_stay_date)::integer in (6, 7)
           and v_room_type.weekend_rate is not null
        then v_room_type.weekend_rate
      else v_room_type.base_rate
    end;
    v_effective_extra := case
      when v_has_override and v_override.extra_adult_rate is not null
        then v_override.extra_adult_rate
      else v_room_type.extra_adult_rate
    end;
    v_effective_child := case
      when v_has_override and v_override.child_rate is not null
        then v_override.child_rate
      else v_room_type.child_rate
    end;
    v_extra_adults := greatest(
      v_quote.adults - (v_room_type.base_occupancy * v_units_required),
      0
    );
    v_line_total := round(case v_room_type.pricing_model
      when 'per_unit' then v_effective_base * v_units_required
      when 'per_person' then
        (v_effective_base * v_quote.adults)
        + (v_effective_child * v_quote.children)
      when 'base_plus_extra' then
        (v_effective_base * v_units_required)
        + (v_effective_extra * v_extra_adults)
        + (v_effective_child * v_quote.children)
    end, 2);

    v_subtotal := v_subtotal + v_line_total;
    v_breakdown := v_breakdown || jsonb_build_array(jsonb_build_object(
      'date', v_stay_date,
      'base_rate', v_effective_base,
      'extra_adult_rate', v_effective_extra,
      'child_rate', v_effective_child,
      'extra_adults', v_extra_adults,
      'line_total', v_line_total
    ));
  end loop;

  v_subtotal := round(v_subtotal, 2);
  v_fees := round(v_settings.service_fee, 2);
  if v_settings.prices_include_tax then
    v_tax := case
      when v_settings.tax_rate = 0 then 0
      else round(v_subtotal - (v_subtotal / (1 + v_settings.tax_rate)), 2)
    end;
    v_total := round(v_subtotal + v_fees, 2);
  else
    v_tax := round(v_subtotal * v_settings.tax_rate, 2);
    v_total := round(v_subtotal + v_tax + v_fees, 2);
  end if;

  -- Igual que pedidos: los montos se recalculan en PostgreSQL y deben seguir
  -- coincidiendo con el snapshot que el huésped aceptó.
  if v_quote.currency is distinct from v_settings.currency
     or (v_snapshot ->> 'units_required')::integer is distinct from v_units_required
     or (v_snapshot ->> 'subtotal')::numeric is distinct from v_subtotal
     or (v_snapshot ->> 'tax')::numeric is distinct from v_tax
     or (v_snapshot ->> 'fees')::numeric is distinct from v_fees
     or (v_snapshot ->> 'total')::numeric is distinct from v_total then
    update public.lodging_quotes
    set status = 'expired'
    where business_id = p_business_id and id = p_quote_id;
    return jsonb_build_object('result', 'quote_expired', 'request', null);
  end if;

  insert into public.lodging_requests (
    business_id, quote_id, room_type_id, room_type_name,
    contact_phone, contact_name, check_in, check_out,
    check_in_time, check_out_time, adults, children,
    units_required, nights, pricing_model, subtotal, tax, fees, total,
    currency, nightly_breakdown, status, expires_at,
    idempotency_key_hash, notes
  ) values (
    p_business_id, p_quote_id, p_room_type_id, v_room_type.name,
    btrim(p_contact_phone), coalesce(nullif(btrim(p_contact_name), ''), v_quote.contact_name),
    v_quote.check_in, v_quote.check_out,
    v_quote.check_in_time, v_quote.check_out_time,
    v_quote.adults, v_quote.children,
    v_units_required, v_quote.nights, v_room_type.pricing_model,
    v_subtotal, v_tax, v_fees, v_total, v_settings.currency, v_breakdown,
    'pending_owner', now() + make_interval(mins => v_settings.hold_minutes),
    v_idempotency_hash, nullif(btrim(p_notes), '')
  ) returning * into v_request;

  insert into public.lodging_blocks (
    business_id, room_type_id, request_id, kind,
    start_date, end_date, quantity, notes
  ) values (
    p_business_id, p_room_type_id, v_request.id, 'request',
    v_quote.check_in, v_quote.check_out, v_units_required,
    'Hold pendiente de confirmación del dueño'
  ) returning * into v_block;

  update public.lodging_quotes
  set status = 'accepted', accepted_at = now()
  where business_id = p_business_id and id = p_quote_id;

  return jsonb_build_object(
    'result', 'created',
    'request', public.lodging_request_to_json(v_request)
  );
exception
  when exclusion_violation then
    return jsonb_build_object('result', 'unavailable', 'request', null);
  when unique_violation then
    select request.*
    into v_existing_request
    from public.lodging_requests as request
    where request.business_id = p_business_id
      and (
        request.idempotency_key_hash = v_idempotency_hash
        or request.quote_id = p_quote_id
      )
    order by request.created_at
    limit 1;

    if found and v_existing_request.status = 'pending_owner' then
      return jsonb_build_object(
        'result', 'duplicate',
        'request', public.lodging_request_to_json(v_existing_request)
      );
    end if;
    if found and v_existing_request.status = 'expired' then
      return jsonb_build_object('result', 'quote_expired', 'request', null);
    end if;
    return jsonb_build_object('result', 'invalid_transition', 'request', null);
end;
$$;


drop trigger if exists trg_lodging_blocks_capacity on public.lodging_blocks;
create trigger trg_lodging_blocks_capacity
before insert or update on public.lodging_blocks
for each row execute function public.enforce_lodging_block_capacity();

-- Evita reducir la capacidad por debajo de compromisos futuros activos. Archivar
-- solo impide nuevas ofertas; no libera ni modifica reservas existentes.
create or replace function public.enforce_lodging_room_type_capacity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.total_units = old.total_units and new.active = old.active then
    new.updated_at := now();
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.business_id::text || ':lodging', 0));

  if new.total_units < old.total_units and exists (
    select 1
    from (
      select occupied_day::date, sum(block.quantity) as occupied_units
      from public.lodging_blocks as block
      left join public.lodging_requests as request
        on request.business_id = block.business_id
       and request.id = block.request_id
      cross join lateral generate_series(
        greatest(
          block.start_date,
          (now() at time zone 'America/Guayaquil')::date
        ),
        block.end_date - 1,
        interval '1 day'
      ) as occupied_day
      where block.business_id = new.business_id
        and block.room_type_id = new.id
        and block.released_at is null
        and block.end_date > (now() at time zone 'America/Guayaquil')::date
        and (
          block.request_id is null
          or request.status = 'confirmed'
          or (
            request.status = 'pending_owner'
            and request.expires_at is not null
            and request.expires_at > now()
          )
        )
      group by occupied_day::date
      having sum(block.quantity) > new.total_units
    ) as over_capacity
  ) then
    raise exception using errcode = '23514', message = 'La capacidad nueva es menor que el inventario ya comprometido';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_lodging_room_types_capacity on public.lodging_room_types;
create trigger trg_lodging_room_types_capacity
before update on public.lodging_room_types
for each row execute function public.enforce_lodging_room_type_capacity();

-- Las mutaciones de configuración usan el mismo lock que cotización/hold. Así
-- una solicitud nunca puede mezclar tarifas anteriores y nuevas dentro del
-- cálculo por noches.
create or replace function public.lock_lodging_configuration()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_business_id uuid;
begin
  v_business_id := case when tg_op = 'DELETE' then old.business_id else new.business_id end;
  perform pg_advisory_xact_lock(hashtextextended(v_business_id::text || ':lodging', 0));

  if tg_op = 'DELETE' then
    return old;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_lodging_settings_configuration_lock
  on public.lodging_settings;
create trigger trg_lodging_settings_configuration_lock
before insert or update or delete on public.lodging_settings
for each row execute function public.lock_lodging_configuration();

drop trigger if exists trg_lodging_room_types_configuration_lock
  on public.lodging_room_types;
create trigger trg_lodging_room_types_configuration_lock
before insert or update or delete on public.lodging_room_types
for each row execute function public.lock_lodging_configuration();

drop trigger if exists trg_lodging_rate_overrides_configuration_lock
  on public.lodging_rate_overrides;
create trigger trg_lodging_rate_overrides_configuration_lock
before insert or update or delete on public.lodging_rate_overrides
for each row execute function public.lock_lodging_configuration();

create or replace function public.lock_business_lodging_toggle()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.lodging_enabled is distinct from old.lodging_enabled then
    perform pg_advisory_xact_lock(hashtextextended(new.id::text || ':lodging', 0));
  end if;

  if old.lodging_enabled is true
     and new.lodging_enabled is false
     and exists (
       select 1
       from public.lodging_requests as request
       join public.lodging_blocks as block
         on block.business_id = request.business_id
        and block.request_id = request.id
       where request.business_id = new.id
         and request.check_out >= (now() at time zone 'America/Guayaquil')::date
         and block.released_at is null
         and (
           request.status = 'confirmed'
           or (
             request.status = 'pending_owner'
             and request.expires_at is not null
             and request.expires_at > now()
           )
         )
     ) then
    raise exception using
      errcode = '23514',
      message = 'No se puede deshabilitar hospedaje con solicitudes o estadías activas';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_businesses_lodging_toggle_lock on public.businesses;
create trigger trg_businesses_lodging_toggle_lock
before update of lodging_enabled on public.businesses
for each row execute function public.lock_business_lodging_toggle();

-- Limpieza explícita e idempotente de holds. La disponibilidad también ignora
-- holds vencidos aunque este mantenimiento no llegue a ejecutarse.
create or replace function public.expire_lodging_holds(p_business_id uuid)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_expired_count integer := 0;
  v_expired_ids uuid[] := array[]::uuid[];
begin
  if p_business_id is null then
    raise exception using errcode = '22023', message = 'El negocio es obligatorio';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text || ':lodging', 0));

  with expired_requests as (
    update public.lodging_requests as request
    set status = 'expired',
        released_at = coalesce(request.released_at, now()),
        updated_at = now()
    where request.business_id = p_business_id
      and request.status = 'pending_owner'
      and request.expires_at is not null
      and request.expires_at <= now()
    returning request.id
  )
  select coalesce(array_agg(id), array[]::uuid[])
  into v_expired_ids
  from expired_requests;

  v_expired_count := cardinality(v_expired_ids);

  -- Sentencia separada: el trigger de blocks ya observa status='expired'.
  if v_expired_count > 0 then
    update public.lodging_blocks as block
    set released_at = coalesce(block.released_at, now()),
        updated_at = now()
    where block.business_id = p_business_id
      and block.request_id = any(v_expired_ids)
      and block.released_at is null;
  end if;

  update public.lodging_quotes as quote
  set status = 'expired'
  where quote.business_id = p_business_id
    and quote.status = 'quoted'
    and quote.expires_at <= now();

  return v_expired_count;
end;
$$;

-- Cotiza todas las opciones activas. Los sábados y domingos (ISO 6/7) usan
-- weekend_rate cuando existe; un override de fecha siempre tiene prioridad.
create or replace function public.quote_lodging_options(
  p_business_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_check_in date,
  p_check_out date,
  p_adults integer,
  p_children integer,
  p_rooms_count integer default 1,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_business public.businesses%rowtype;
  v_settings public.lodging_settings%rowtype;
  v_quote public.lodging_quotes%rowtype;
  v_existing_quote public.lodging_quotes%rowtype;
  v_room_type public.lodging_room_types%rowtype;
  v_override public.lodging_rate_overrides%rowtype;
  v_options jsonb := '[]'::jsonb;
  v_breakdown jsonb;
  v_option jsonb;
  v_idempotency_hash text;
  v_nights integer;
  v_total_guests integer;
  v_units_required integer;
  v_available_units integer;
  v_stay_date date;
  v_has_override boolean;
  v_closed boolean;
  v_effective_base numeric(12,2);
  v_effective_extra numeric(12,2);
  v_effective_child numeric(12,2);
  v_extra_adults integer;
  v_line_total numeric(12,2);
  v_subtotal numeric(12,2);
  v_tax numeric(12,2);
  v_fees numeric(12,2);
  v_total numeric(12,2);
begin
  if p_business_id is null then
    raise exception using errcode = '22023', message = 'El negocio es obligatorio';
  end if;
  if nullif(btrim(p_contact_phone), '') is null
     or char_length(btrim(p_contact_phone)) > 80 then
    raise exception using errcode = '22023', message = 'El contacto es obligatorio';
  end if;
  if p_check_in is null or p_check_out is null or p_check_out <= p_check_in then
    raise exception using errcode = '22023', message = 'El rango de hospedaje es inválido';
  end if;
  if p_check_in < (now() at time zone 'America/Guayaquil')::date then
    raise exception using errcode = '22023', message = 'La fecha de entrada no puede estar en el pasado';
  end if;

  v_nights := p_check_out - p_check_in;
  if v_nights not between 1 and 366 then
    raise exception using errcode = '22023', message = 'La estadía debe tener entre 1 y 366 noches';
  end if;
  if coalesce(p_adults, 0) not between 1 and 500
     or coalesce(p_children, -1) not between 0 and 500 then
    raise exception using errcode = '22023', message = 'La cantidad de huéspedes es inválida';
  end if;
  if coalesce(p_rooms_count, 0) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'La cantidad mínima de habitaciones es inválida';
  end if;
  if p_idempotency_key is not null
     and char_length(p_idempotency_key) not between 1 and 512 then
    raise exception using errcode = '22023', message = 'La clave de idempotencia es inválida';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text || ':lodging', 0));

  select business.*
  into v_business
  from public.businesses as business
  where business.id = p_business_id
  for share;

  if not found then
    raise exception using errcode = '23503', message = 'El negocio no existe';
  end if;
  if v_business.lodging_enabled is distinct from true
     or v_business.active is distinct from true
     or v_business.suspended is true then
    raise exception using errcode = '42501', message = 'El módulo de hospedaje no está habilitado';
  end if;

  -- Compatibilidad para negocios habilitados antes de guardar configuración.
  insert into public.lodging_settings (business_id)
  values (p_business_id)
  on conflict (business_id) do nothing;

  select settings.*
  into v_settings
  from public.lodging_settings as settings
  where settings.business_id = p_business_id
  for share;

  perform public.expire_lodging_holds(p_business_id);

  if p_idempotency_key is not null then
    v_idempotency_hash := encode(
      sha256(convert_to(p_idempotency_key, 'UTF8')),
      'hex'
    );

    select quote.*
    into v_existing_quote
    from public.lodging_quotes as quote
    where quote.business_id = p_business_id
      and quote.idempotency_key_hash = v_idempotency_hash;

    if found then
      if v_existing_quote.contact_phone <> btrim(p_contact_phone)
         or v_existing_quote.check_in <> p_check_in
         or v_existing_quote.check_out <> p_check_out
         or v_existing_quote.adults <> p_adults
         or v_existing_quote.children <> p_children
         or v_existing_quote.rooms_count <> p_rooms_count then
        raise exception using errcode = '22023', message = 'La clave de idempotencia ya fue usada con otros datos';
      end if;

      if v_existing_quote.status = 'expired'
         or v_existing_quote.expires_at <= now() then
        return jsonb_build_object('result', 'quote_expired', 'quote', null, 'options', '[]'::jsonb);
      end if;
      if v_existing_quote.status = 'accepted' then
        return jsonb_build_object('result', 'invalid_transition', 'quote', null, 'options', '[]'::jsonb);
      end if;

      return jsonb_build_object(
        'result', 'quoted',
        'duplicate', true,
        'quote', (to_jsonb(v_existing_quote) - 'options' - 'idempotency_key_hash')
          || jsonb_build_object(
            'check_in_time', to_char(v_existing_quote.check_in_time, 'HH24:MI'),
            'check_out_time', to_char(v_existing_quote.check_out_time, 'HH24:MI')
          ),
        'options', v_existing_quote.options
      );
    end if;
  end if;

  v_total_guests := p_adults + p_children;

  for v_room_type in
    select room_type.*
    from public.lodging_room_types as room_type
    where room_type.business_id = p_business_id
      and room_type.active is true
    order by room_type.name, room_type.id
  loop
    v_units_required := greatest(
      p_rooms_count,
      ceil(v_total_guests::numeric / v_room_type.max_guests)::integer
    );

    select coalesce(min(
      v_room_type.total_units - coalesce((
        select sum(block.quantity)
        from public.lodging_blocks as block
        left join public.lodging_requests as request
          on request.business_id = block.business_id
         and request.id = block.request_id
        where block.business_id = p_business_id
          and block.room_type_id = v_room_type.id
          and block.released_at is null
          and block.start_date <= occupied_day::date
          and block.end_date > occupied_day::date
          and (
            block.request_id is null
            or request.status = 'confirmed'
            or (
              request.status = 'pending_owner'
              and request.expires_at is not null
              and request.expires_at > now()
            )
          )
      ), 0)
    ), v_room_type.total_units)::integer
    into v_available_units
    from generate_series(p_check_in, p_check_out - 1, interval '1 day') as occupied_day;

    v_closed := exists (
      select 1
      from public.lodging_rate_overrides as override
      where override.business_id = p_business_id
        and override.room_type_id = v_room_type.id
        and override.rate_date >= p_check_in
        and override.rate_date < p_check_out
        and override.closed is true
    );

    v_breakdown := '[]'::jsonb;
    v_subtotal := null;
    v_tax := null;
    v_fees := null;
    v_total := null;

    if v_room_type.pricing_model <> 'manual' then
      v_subtotal := 0;

      for v_stay_date in
        select day_value::date
        from generate_series(p_check_in, p_check_out - 1, interval '1 day') as day_value
      loop
        v_has_override := false;
        select override.*
        into v_override
        from public.lodging_rate_overrides as override
        where override.business_id = p_business_id
          and override.room_type_id = v_room_type.id
          and override.rate_date = v_stay_date;
        v_has_override := found;

        v_effective_base := case
          when v_has_override and v_override.base_rate is not null
            then v_override.base_rate
          when extract(isodow from v_stay_date)::integer in (6, 7)
               and v_room_type.weekend_rate is not null
            then v_room_type.weekend_rate
          else v_room_type.base_rate
        end;
        v_effective_extra := case
          when v_has_override and v_override.extra_adult_rate is not null
            then v_override.extra_adult_rate
          else v_room_type.extra_adult_rate
        end;
        v_effective_child := case
          when v_has_override and v_override.child_rate is not null
            then v_override.child_rate
          else v_room_type.child_rate
        end;

        v_extra_adults := greatest(
          p_adults - (v_room_type.base_occupancy * v_units_required),
          0
        );
        v_line_total := round(case v_room_type.pricing_model
          when 'per_unit' then v_effective_base * v_units_required
          when 'per_person' then
            (v_effective_base * p_adults) + (v_effective_child * p_children)
          when 'base_plus_extra' then
            (v_effective_base * v_units_required)
            + (v_effective_extra * v_extra_adults)
            + (v_effective_child * p_children)
        end, 2);

        v_subtotal := v_subtotal + v_line_total;
        v_breakdown := v_breakdown || jsonb_build_array(jsonb_build_object(
          'date', v_stay_date,
          'base_rate', v_effective_base,
          'extra_adult_rate', v_effective_extra,
          'child_rate', v_effective_child,
          'extra_adults', v_extra_adults,
          'line_total', v_line_total
        ));
      end loop;

      v_subtotal := round(v_subtotal, 2);
      v_fees := round(v_settings.service_fee, 2);
      if v_settings.prices_include_tax then
        v_tax := case
          when v_settings.tax_rate = 0 then 0
          else round(v_subtotal - (v_subtotal / (1 + v_settings.tax_rate)), 2)
        end;
        v_total := round(v_subtotal + v_fees, 2);
      else
        v_tax := round(v_subtotal * v_settings.tax_rate, 2);
        v_total := round(v_subtotal + v_tax + v_fees, 2);
      end if;
    end if;

    v_option := jsonb_build_object(
      'room_type_id', v_room_type.id,
      'name', v_room_type.name,
      'description', v_room_type.description,
      'amenities', to_jsonb(v_room_type.amenities),
      'media_urls', to_jsonb(v_room_type.media_urls),
      'pricing_model', v_room_type.pricing_model,
      'total_units', v_room_type.total_units,
      'available_units', greatest(v_available_units, 0),
      'units_required', v_units_required,
      'base_occupancy', v_room_type.base_occupancy,
      'max_guests', v_room_type.max_guests,
      'nights', v_nights,
      'check_in_time', to_char(v_settings.check_in_time, 'HH24:MI'),
      'check_out_time', to_char(v_settings.check_out_time, 'HH24:MI'),
      'currency', v_settings.currency,
      'subtotal', v_subtotal,
      'tax', v_tax,
      'fees', v_fees,
      'total', v_total,
      'prices_include_tax', v_settings.prices_include_tax,
      'nightly_rates', v_breakdown,
      'nightly_breakdown', v_breakdown,
      'available', (
        not v_closed
        and v_available_units >= v_units_required
        and v_units_required <= v_room_type.total_units
      ),
      'closed', v_closed
    );
    if not v_closed
       and v_available_units >= v_units_required
       and v_units_required <= v_room_type.total_units then
      v_options := v_options || jsonb_build_array(v_option);
    end if;
  end loop;

  insert into public.lodging_quotes (
    business_id, contact_phone, contact_name, check_in, check_out,
    check_in_time, check_out_time,
    adults, children, rooms_count, nights, currency, options,
    status, expires_at, idempotency_key_hash
  ) values (
    p_business_id, btrim(p_contact_phone), nullif(btrim(p_contact_name), ''),
    p_check_in, p_check_out, v_settings.check_in_time, v_settings.check_out_time,
    p_adults, p_children, p_rooms_count, v_nights,
    v_settings.currency, v_options, 'quoted',
    now() + make_interval(mins => v_settings.quote_expiry_minutes),
    v_idempotency_hash
  ) returning * into v_quote;

  return jsonb_build_object(
    'result', 'quoted',
    'quote', (to_jsonb(v_quote) - 'options' - 'idempotency_key_hash')
      || jsonb_build_object(
        'check_in_time', to_char(v_quote.check_in_time, 'HH24:MI'),
        'check_out_time', to_char(v_quote.check_out_time, 'HH24:MI')
      ),
    'options', v_options
  );
end;
$$;

-- Mantiene el onboarding completo en una sola transacción e incorpora la
-- capacidad de hospedaje.
create or replace function public.create_business_onboarding(
  p_business jsonb,
  p_client_email text default null,
  p_password_hash text default null,
  p_monthly_rate numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business public.businesses%rowtype;
  v_name text := btrim(coalesce(p_business ->> 'name', ''));
  v_slug text := btrim(coalesce(p_business ->> 'slug', ''));
  v_whatsapp_number text := btrim(coalesce(p_business ->> 'whatsapp_number', ''));
  v_client_email text := nullif(btrim(coalesce(p_client_email, '')), '');
  v_password_hash text := nullif(p_password_hash, '');
  v_lodging_enabled boolean := coalesce((p_business ->> 'lodging_enabled')::boolean, false);
begin
  if jsonb_typeof(p_business) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Los datos del negocio son inválidos';
  end if;
  if v_name = '' or v_slug = '' or v_whatsapp_number = '' then
    raise exception using errcode = '22023', message = 'Nombre, slug y número son obligatorios';
  end if;
  if (v_client_email is null) <> (v_password_hash is null) then
    raise exception using errcode = '22023', message = 'Email y contraseña deben enviarse juntos';
  end if;
  if v_password_hash is not null and v_password_hash !~ '^\$2[aby]\$[0-9]{2}\$' then
    raise exception using errcode = '22023', message = 'La contraseña debe llegar cifrada';
  end if;
  if p_monthly_rate is not null and p_monthly_rate <= 0 then
    raise exception using errcode = '22023', message = 'La tarifa mensual debe ser mayor que cero';
  end if;

  insert into public.businesses (
    slug, name, type, whatsapp_number, whatsapp_provider,
    ycloud_api_key, ycloud_number,
    ycloud_webhook_endpoint_id, ycloud_webhook_secret,
    meta_token, meta_phone_id, telegram_bot_token,
    takes_bookings, takes_orders, lodging_enabled, ai_provider,
    owner_phone, plan, plan_expires_at,
    active, bot_active, suspended, notes, monthly_rate
  ) values (
    v_slug,
    v_name,
    coalesce(nullif(p_business ->> 'type', ''), 'negocio'),
    v_whatsapp_number,
    coalesce(nullif(p_business ->> 'whatsapp_provider', ''), 'ycloud'),
    nullif(p_business ->> 'ycloud_api_key', ''),
    nullif(p_business ->> 'ycloud_number', ''),
    nullif(btrim(p_business ->> 'ycloud_webhook_endpoint_id'), ''),
    nullif(p_business ->> 'ycloud_webhook_secret', ''),
    nullif(p_business ->> 'meta_token', ''),
    nullif(p_business ->> 'meta_phone_id', ''),
    nullif(p_business ->> 'telegram_bot_token', ''),
    coalesce((p_business ->> 'takes_bookings')::boolean, false),
    coalesce((p_business ->> 'takes_orders')::boolean, true),
    v_lodging_enabled,
    nullif(p_business ->> 'ai_provider', ''),
    nullif(p_business ->> 'owner_phone', ''),
    coalesce(nullif(p_business ->> 'plan', ''), 'basic'),
    nullif(p_business ->> 'plan_expires_at', '')::timestamptz,
    true,
    true,
    false,
    nullif(p_business ->> 'notes', ''),
    p_monthly_rate
  ) returning * into v_business;

  insert into public.bot_policies (business_id) values (v_business.id);

  insert into public.business_schedule (
    business_id, day_of_week, open_time, close_time, slot_duration, is_active
  ) values
    (v_business.id, 0, '09:00', '18:00', 60, false),
    (v_business.id, 1, '09:00', '18:00', 60, true),
    (v_business.id, 2, '09:00', '18:00', 60, true),
    (v_business.id, 3, '09:00', '18:00', 60, true),
    (v_business.id, 4, '09:00', '18:00', 60, true),
    (v_business.id, 5, '09:00', '18:00', 60, true),
    (v_business.id, 6, '09:00', '13:00', 60, true)
  on conflict (business_id, day_of_week) do nothing;

  if v_lodging_enabled then
    insert into public.lodging_settings (business_id)
    values (v_business.id)
    on conflict (business_id) do nothing;
  end if;

  if v_client_email is not null then
    insert into public.client_users (business_id, email, password_hash, role)
    values (v_business.id, v_client_email, v_password_hash, 'owner');
  end if;

  if p_monthly_rate is not null then
    insert into public.billing (business_id, amount, status, period_start, period_end)
    select
      v_business.id,
      p_monthly_rate,
      'pending',
      (date_trunc('month', current_date) + make_interval(months => month_offset))::date,
      (date_trunc('month', current_date) + make_interval(months => month_offset + 1)
        - interval '1 day')::date
    from generate_series(0, 11) as month_offset;
  end if;

  return to_jsonb(v_business);
end;
$$;

alter table public.lodging_settings enable row level security;
alter table public.lodging_room_types enable row level security;
alter table public.lodging_rate_overrides enable row level security;
alter table public.lodging_quotes enable row level security;
alter table public.lodging_requests enable row level security;
alter table public.lodging_blocks enable row level security;

revoke all on table
  public.lodging_settings,
  public.lodging_room_types,
  public.lodging_rate_overrides,
  public.lodging_quotes,
  public.lodging_requests,
  public.lodging_blocks
from public, anon, authenticated;

grant select, insert, update, delete on table
  public.lodging_settings,
  public.lodging_room_types,
  public.lodging_rate_overrides,
  public.lodging_quotes,
  public.lodging_requests
to service_role;

grant select, insert, update on table public.lodging_blocks to service_role;

revoke all on function public.enforce_lodging_block_capacity()
  from public, anon, authenticated;
revoke all on function public.lodging_request_to_json(public.lodging_requests)
  from public, anon, authenticated;
grant execute on function public.lodging_request_to_json(public.lodging_requests)
  to service_role;
revoke all on function public.enforce_lodging_room_type_capacity()
  from public, anon, authenticated;
revoke all on function public.lock_lodging_configuration()
  from public, anon, authenticated;
revoke all on function public.lock_business_lodging_toggle()
  from public, anon, authenticated;

revoke all on function public.expire_lodging_holds(uuid)
  from public, anon, authenticated;
grant execute on function public.expire_lodging_holds(uuid) to service_role;

revoke all on function public.quote_lodging_options(
  uuid, text, text, date, date, integer, integer, integer, text
) from public, anon, authenticated;
grant execute on function public.quote_lodging_options(
  uuid, text, text, date, date, integer, integer, integer, text
) to service_role;

revoke all on function public.create_lodging_request_if_available(
  uuid, uuid, uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_lodging_request_if_available(
  uuid, uuid, uuid, text, text, text, text
) to service_role;

revoke all on function public.set_lodging_request_status(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_lodging_request_status(uuid, uuid, text)
  to service_role;

revoke all on function public.upsert_lodging_block_if_available(
  uuid, uuid, text, date, date, integer, text, uuid
) from public, anon, authenticated;
grant execute on function public.upsert_lodging_block_if_available(
  uuid, uuid, text, date, date, integer, text, uuid
) to service_role;

revoke all on function public.release_lodging_block(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.release_lodging_block(uuid, uuid)
  to service_role;

revoke all on function public.create_business_onboarding(jsonb, text, text, numeric)
  from public, anon, authenticated;
grant execute on function public.create_business_onboarding(jsonb, text, text, numeric)
  to service_role;

commit;

-- ============================================================
-- FACTURACIÓN MENSUAL AUTOMÁTICA + CATÁLOGO DE SEIS PLANES
-- Fecha: 2026-07-27
--
-- Ejecutar en Supabase → SQL Editor antes de desplegar el backend.
--
-- Esta migración:
--   • conserva íntegramente las facturas históricas y las cuotas futuras;
--   • impide nuevas cuotas duplicadas por negocio y mes;
--   • genera únicamente la cuota del mes corriente de Ecuador;
--   • factura solo negocios activos y no suspendidos;
--   • reemplaza el onboarding de 12 cuotas por una sola cuota corriente;
--   • migra únicamente el código legado premium a scale.
--
-- No elimina la columna de vencimiento ni reescribe tarifas o cobros.
-- ============================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

lock table public.businesses in share row exclusive mode;
lock table public.billing in share row exclusive mode;

-- Compatibilidad si migration-consumo-planes.sql todavía no se aplicó. Las
-- altas nuevas reciben límites explícitos según el plan; los negocios actuales
-- conservan exactamente sus límites y tarifas.
alter table public.businesses
  add column if not exists monthly_contact_limit integer,
  add column if not exists monthly_outbound_message_limit integer;

-- Una alta sin selección explícita empieza en Micro. ALTER DEFAULT no cambia
-- ninguna fila existente.
alter table public.businesses
  alter column plan set default 'micro',
  alter column monthly_contact_limit set default 50,
  alter column monthly_outbound_message_limit set default 250;

-- premium tenía exactamente la capacidad que ahora corresponde a scale.
-- No se toca monthly_rate, los límites ni ninguna factura existente.
update public.businesses
set plan = 'scale'
where lower(btrim(coalesce(plan, ''))) = 'premium';

-- Fuente de verdad del catálogo en PostgreSQL. Las RPC financieras consultan
-- esta función y rechazan cualquier tarifa o límite distinto.
create or replace function public.billing_plan_definition(p_plan text)
returns table (
  plan_code text,
  monthly_rate numeric,
  monthly_contact_limit integer,
  monthly_outbound_message_limit integer
)
language sql
immutable
set search_path = public, pg_temp
as $$
  select
    catalog.plan_code,
    catalog.monthly_rate,
    catalog.monthly_contact_limit,
    catalog.monthly_outbound_message_limit
  from (
    values
      ('micro'::text,      25::numeric,  50,  250),
      ('basic'::text,      50::numeric, 200, 1000),
      ('pro'::text,        99::numeric, 400, 2000),
      ('growth'::text,    199::numeric, 800, 4000),
      ('scale'::text,     499::numeric, 2000, 10000),
      ('enterprise'::text, 899::numeric, 4000, 20000)
  ) as catalog (
    plan_code,
    monthly_rate,
    monthly_contact_limit,
    monthly_outbound_message_limit
  )
  where catalog.plan_code = lower(btrim(coalesce(p_plan, '')));
$$;

revoke all on function public.billing_plan_definition(text)
  from public, anon, authenticated;
grant execute on function public.billing_plan_definition(text)
  to service_role;

-- Una tabla auxiliar reclama atómicamente cada combinación negocio/mes. Esto
-- permite conservar posibles duplicados históricos sin borrarlos, pero bloquea
-- cualquier duplicado nuevo incluso si dos servidores facturan a la vez.
create table if not exists public.billing_month_claims (
  business_id  uuid not null
               references public.businesses(id) on delete cascade,
  period_start date not null,
  billing_id   uuid
               references public.billing(id) on delete set null,
  claimed_at   timestamptz not null default now(),
  primary key (business_id, period_start)
);

-- Registra las cuotas existentes, incluidas las doce futuras creadas por la
-- versión anterior. DISTINCT ON conserva todas las facturas; solo elige una
-- como referencia de la clave mensual.
insert into public.billing_month_claims (
  business_id,
  period_start,
  billing_id,
  claimed_at
)
select distinct on (
  billing.business_id,
  date_trunc('month', billing.period_start)::date
)
  billing.business_id,
  date_trunc('month', billing.period_start)::date,
  billing.id,
  coalesce(billing.created_at, now())
from public.billing
where billing.period_start is not null
order by
  billing.business_id,
  date_trunc('month', billing.period_start)::date,
  billing.created_at nulls last,
  billing.id
on conflict (business_id, period_start) do nothing;

alter table public.billing_month_claims enable row level security;
revoke all on table public.billing_month_claims
  from public, anon, authenticated;
grant select on table public.billing_month_claims to service_role;

create or replace function public.claim_billing_month()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claimed_business_id uuid;
begin
  -- Los registros históricos sin período se preservan, pero la automatización
  -- siempre crea períodos completos y sí queda protegida.
  if new.period_start is null then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.business_id is not distinct from old.business_id
       and date_trunc('month', new.period_start)::date
         is not distinct from date_trunc('month', old.period_start)::date then
      return new;
    end if;
  end if;

  insert into public.billing_month_claims (
    business_id,
    period_start,
    billing_id
  ) values (
    new.business_id,
    date_trunc('month', new.period_start)::date,
    new.id
  )
  on conflict (business_id, period_start) do nothing
  returning business_id into v_claimed_business_id;

  if v_claimed_business_id is null then
    raise exception using
      errcode = '23505',
      message = 'Ya existe una cuota para este negocio y mes',
      constraint = 'billing_one_charge_per_business_month';
  end if;

  return new;
end;
$$;

revoke all on function public.claim_billing_month()
  from public, anon, authenticated;

drop trigger if exists billing_claim_month on public.billing;
-- AFTER, no BEFORE: el disparador apunta con `billing_id` a la fila recién
-- creada de `billing`, y en un BEFORE esa fila todavía no existe. Fue así
-- hasta el 2026-08-02 y hacía imposible dar de alta cualquier cliente nuevo
-- (ver server/migration-arreglo-cuota-alta.sql).
create trigger billing_claim_month
after insert or update of business_id, period_start on public.billing
for each row execute function public.claim_billing_month();

-- Se invoca al arrancar el servidor y luego una vez al día. La fecha se calcula
-- siempre como calendario de Ecuador, independientemente del huso horario de
-- Railway o Supabase.
create or replace function public.ensure_current_month_billing()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period_start date :=
    date_trunc('month', timezone('America/Guayaquil', now()))::date;
  v_period_end date :=
    (v_period_start + interval '1 month' - interval '1 day')::date;
  v_business record;
  v_created integer := 0;
begin
  for v_business in
    select business.id, business.monthly_rate
    from public.businesses as business
    where business.active is true
      and coalesce(business.suspended, false) is false
      and business.monthly_rate is not null
      and business.monthly_rate > 0
  loop
    if not exists (
      select 1
      from public.billing as charge
      where charge.business_id = v_business.id
        and charge.period_start >= v_period_start
        and charge.period_start <= v_period_end
    ) then
      begin
        insert into public.billing (
          business_id,
          amount,
          currency,
          period_start,
          period_end,
          status,
          notes
        ) values (
          v_business.id,
          v_business.monthly_rate,
          'USD',
          v_period_start,
          v_period_end,
          'pending',
          'Cuota mensual automática'
        );
        v_created := v_created + 1;
      exception
        -- Otra instancia pudo reclamar el mes entre el NOT EXISTS y el INSERT.
        -- El trigger garantiza que esa carrera termina en una sola cuota.
        when unique_violation then null;
      end;
    end if;
  end loop;

  return v_created;
end;
$$;

revoke all on function public.ensure_current_month_billing()
  from public, anon, authenticated;
grant execute on function public.ensure_current_month_billing()
  to service_role;

-- Reactivar conserva la suspensión como decisión manual y emite de inmediato
-- la cuota corriente si corresponde; nunca altera una fecha de vencimiento.
create or replace function public.reactivate_business_with_billing(
  p_business_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business public.businesses%rowtype;
  v_period_start date :=
    date_trunc('month', timezone('America/Guayaquil', now()))::date;
  v_period_end date :=
    (v_period_start + interval '1 month' - interval '1 day')::date;
begin
  update public.businesses
  set suspended = false,
      bot_active = true,
      suspension_reason = null
  where id = p_business_id
  returning * into v_business;

  if not found then
    return false;
  end if;

  if v_business.active is true
     and v_business.monthly_rate is not null
     and v_business.monthly_rate > 0
     and not exists (
       select 1
       from public.billing as charge
       where charge.business_id = v_business.id
         and charge.period_start >= v_period_start
         and charge.period_start <= v_period_end
     ) then
    begin
      insert into public.billing (
        business_id,
        amount,
        currency,
        period_start,
        period_end,
        status,
        notes
      ) values (
        v_business.id,
        v_business.monthly_rate,
        'USD',
        v_period_start,
        v_period_end,
        'pending',
        'Cuota mensual automática'
      );
    exception
      when unique_violation then null;
    end;
  end if;

  return true;
end;
$$;

revoke all on function public.reactivate_business_with_billing(uuid)
  from public, anon, authenticated;
grant execute on function public.reactivate_business_with_billing(uuid)
  to service_role;

-- Cambio de plan transaccional: negocio, tarifa y límites quedan sincronizados.
-- Solo actualiza cuotas pendientes del mes corriente o posteriores; nunca toca
-- cobros pagados ni facturas de meses anteriores.
create or replace function public.update_business_plan_billing(
  p_business_id uuid,
  p_plan text,
  p_monthly_rate numeric,
  p_monthly_contact_limit integer,
  p_monthly_outbound_message_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan text := lower(btrim(coalesce(p_plan, '')));
  v_plan_definition record;
  v_business public.businesses%rowtype;
  v_period_start date :=
    date_trunc('month', timezone('America/Guayaquil', now()))::date;
  v_period_end date :=
    (v_period_start + interval '1 month' - interval '1 day')::date;
begin
  select *
  into v_plan_definition
  from public.billing_plan_definition(v_plan);

  if not found then
    raise exception using
      errcode = '22023',
      message = 'El plan seleccionado no existe';
  end if;
  if p_monthly_rate is distinct from v_plan_definition.monthly_rate
     or p_monthly_contact_limit
       is distinct from v_plan_definition.monthly_contact_limit
     or p_monthly_outbound_message_limit
       is distinct from v_plan_definition.monthly_outbound_message_limit then
    raise exception using
      errcode = '22023',
      message = 'La tarifa o los límites no coinciden con el catálogo del plan';
  end if;

  update public.businesses
  set plan = v_plan_definition.plan_code,
      monthly_rate = v_plan_definition.monthly_rate,
      monthly_contact_limit = v_plan_definition.monthly_contact_limit,
      monthly_outbound_message_limit =
        v_plan_definition.monthly_outbound_message_limit
  where id = p_business_id
  returning * into v_business;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'El negocio no existe';
  end if;

  update public.billing
  set amount = v_plan_definition.monthly_rate
  where business_id = p_business_id
    and status = 'pending'
    and period_start >= v_period_start;

  if v_business.active is true
     and coalesce(v_business.suspended, false) is false
     and not exists (
       select 1
       from public.billing as charge
       where charge.business_id = v_business.id
         and charge.period_start >= v_period_start
         and charge.period_start <= v_period_end
     ) then
    begin
      insert into public.billing (
        business_id,
        amount,
        currency,
        period_start,
        period_end,
        status,
        notes
      ) values (
        v_business.id,
        v_plan_definition.monthly_rate,
        'USD',
        v_period_start,
        v_period_end,
        'pending',
        'Cuota mensual automática'
      );
    exception
      when unique_violation then null;
    end;
  end if;

  return to_jsonb(v_business);
end;
$$;

revoke all on function public.update_business_plan_billing(
  uuid,
  text,
  numeric,
  integer,
  integer
) from public, anon, authenticated;
grant execute on function public.update_business_plan_billing(
  uuid,
  text,
  numeric,
  integer,
  integer
) to service_role;

-- Alta atómica actualizada. Los códigos y capacidades oficiales son:
--   micro      $25  ·   50 contactos ·    250 mensajes
--   basic      $50  ·  200 contactos ·  1.000 mensajes (Inicial)
--   pro        $99  ·  400 contactos ·  2.000 mensajes
--   growth    $199  ·  800 contactos ·  4.000 mensajes
--   scale     $499  · 2000 contactos · 10.000 mensajes
--   enterprise $899 · 4000 contactos · 20.000 mensajes
create or replace function public.create_business_onboarding(
  p_business jsonb,
  p_client_email text default null,
  p_password_hash text default null,
  p_monthly_rate numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business public.businesses%rowtype;
  v_name text := btrim(coalesce(p_business ->> 'name', ''));
  v_slug text := btrim(coalesce(p_business ->> 'slug', ''));
  v_whatsapp_number text :=
    btrim(coalesce(p_business ->> 'whatsapp_number', ''));
  v_client_email text :=
    nullif(btrim(coalesce(p_client_email, '')), '');
  v_password_hash text := nullif(p_password_hash, '');
  v_lodging_enabled boolean :=
    coalesce((p_business ->> 'lodging_enabled')::boolean, false);
  v_chat_mode text :=
    coalesce(nullif(btrim(p_business ->> 'chat_mode'), ''), 'ai');
  v_plan text :=
    lower(coalesce(nullif(btrim(p_business ->> 'plan'), ''), 'micro'));
  v_plan_definition record;
  v_monthly_rate numeric;
  v_contact_limit integer;
  v_outbound_limit integer;
  v_period_start date :=
    date_trunc('month', timezone('America/Guayaquil', now()))::date;
  v_period_end date :=
    (v_period_start + interval '1 month' - interval '1 day')::date;
begin
  if jsonb_typeof(p_business) is distinct from 'object' then
    raise exception using
      errcode = '22023',
      message = 'Los datos del negocio son inválidos';
  end if;
  if v_name = '' or v_slug = '' or v_whatsapp_number = '' then
    raise exception using
      errcode = '22023',
      message = 'Nombre, slug y número son obligatorios';
  end if;
  if (v_client_email is null) <> (v_password_hash is null) then
    raise exception using
      errcode = '22023',
      message = 'Email y contraseña deben enviarse juntos';
  end if;
  if v_password_hash is not null
     and v_password_hash !~ '^\$2[aby]\$[0-9]{2}\$' then
    raise exception using
      errcode = '22023',
      message = 'La contraseña debe llegar cifrada';
  end if;
  if v_chat_mode not in ('menu', 'ai') then
    raise exception using
      errcode = '22023',
      message = 'El modo de conversación debe ser menu o ai';
  end if;

  select *
  into v_plan_definition
  from public.billing_plan_definition(v_plan);

  if not found then
    raise exception using
      errcode = '22023',
      message = 'El plan seleccionado no existe';
  end if;

  if p_monthly_rate is not null
     and p_monthly_rate is distinct from v_plan_definition.monthly_rate then
    raise exception using
      errcode = '22023',
      message = 'La tarifa no coincide con el catálogo del plan';
  end if;
  if nullif(p_business ->> 'monthly_contact_limit', '') is not null
     and nullif(p_business ->> 'monthly_contact_limit', '')::integer
       is distinct from v_plan_definition.monthly_contact_limit then
    raise exception using
      errcode = '22023',
      message = 'El límite de contactos no coincide con el catálogo del plan';
  end if;
  if nullif(
    p_business ->> 'monthly_outbound_message_limit',
    ''
  ) is not null
     and nullif(
       p_business ->> 'monthly_outbound_message_limit',
       ''
     )::integer
       is distinct from v_plan_definition.monthly_outbound_message_limit then
    raise exception using
      errcode = '22023',
      message = 'El límite de mensajes no coincide con el catálogo del plan';
  end if;

  v_plan := v_plan_definition.plan_code;
  v_monthly_rate := v_plan_definition.monthly_rate;
  v_contact_limit := v_plan_definition.monthly_contact_limit;
  v_outbound_limit := v_plan_definition.monthly_outbound_message_limit;

  insert into public.businesses (
    slug,
    name,
    type,
    whatsapp_number,
    whatsapp_provider,
    ycloud_api_key,
    ycloud_number,
    ycloud_webhook_endpoint_id,
    ycloud_webhook_secret,
    meta_token,
    meta_phone_id,
    telegram_bot_token,
    takes_bookings,
    takes_orders,
    lodging_enabled,
    chat_mode,
    ai_provider,
    owner_phone,
    plan,
    active,
    bot_active,
    suspended,
    notes,
    monthly_rate,
    monthly_contact_limit,
    monthly_outbound_message_limit
  ) values (
    v_slug,
    v_name,
    coalesce(nullif(p_business ->> 'type', ''), 'negocio'),
    v_whatsapp_number,
    coalesce(nullif(p_business ->> 'whatsapp_provider', ''), 'ycloud'),
    nullif(p_business ->> 'ycloud_api_key', ''),
    nullif(p_business ->> 'ycloud_number', ''),
    nullif(btrim(p_business ->> 'ycloud_webhook_endpoint_id'), ''),
    nullif(p_business ->> 'ycloud_webhook_secret', ''),
    nullif(p_business ->> 'meta_token', ''),
    nullif(p_business ->> 'meta_phone_id', ''),
    nullif(p_business ->> 'telegram_bot_token', ''),
    coalesce((p_business ->> 'takes_bookings')::boolean, false),
    coalesce((p_business ->> 'takes_orders')::boolean, true),
    v_lodging_enabled,
    v_chat_mode,
    nullif(p_business ->> 'ai_provider', ''),
    nullif(p_business ->> 'owner_phone', ''),
    v_plan,
    true,
    true,
    false,
    nullif(p_business ->> 'notes', ''),
    v_monthly_rate,
    v_contact_limit,
    v_outbound_limit
  )
  returning * into v_business;

  insert into public.bot_policies (business_id)
  values (v_business.id);

  insert into public.business_schedule (
    business_id,
    day_of_week,
    open_time,
    close_time,
    slot_duration,
    is_active
  ) values
    (v_business.id, 0, '09:00', '18:00', 60, false),
    (v_business.id, 1, '09:00', '18:00', 60, true),
    (v_business.id, 2, '09:00', '18:00', 60, true),
    (v_business.id, 3, '09:00', '18:00', 60, true),
    (v_business.id, 4, '09:00', '18:00', 60, true),
    (v_business.id, 5, '09:00', '18:00', 60, true),
    (v_business.id, 6, '09:00', '13:00', 60, true)
  on conflict (business_id, day_of_week) do nothing;

  if v_lodging_enabled then
    insert into public.lodging_settings (business_id)
    values (v_business.id)
    on conflict (business_id) do nothing;
  end if;

  if v_client_email is not null then
    insert into public.client_users (
      business_id,
      email,
      password_hash,
      role
    ) values (
      v_business.id,
      v_client_email,
      v_password_hash,
      'owner'
    );
  end if;

  insert into public.billing (
    business_id,
    amount,
    currency,
    status,
    period_start,
    period_end,
    notes
  ) values (
    v_business.id,
    v_monthly_rate,
    'USD',
    'pending',
    v_period_start,
    v_period_end,
    'Cuota mensual automática'
  );

  return to_jsonb(v_business);
end;
$$;

revoke all on function public.create_business_onboarding(
  jsonb,
  text,
  text,
  numeric
) from public, anon, authenticated;
grant execute on function public.create_business_onboarding(
  jsonb,
  text,
  text,
  numeric
) to service_role;

commit;

-- ── HOSPEDAJE: la estadía confirmada también es una venta ──
-- (migration-2026-08-02-estadia-confirmada-es-venta.sql)
-- ── 1. La venta sabe de qué estadía salió ─────────────────────────────────
alter table public.sales
  add column if not exists lodging_request_id uuid
    references public.lodging_requests(id) on delete set null;

-- Una estadía, una venta como máximo. Igual que en pedidos y citas: es lo que
-- impide duplicar el dinero si se confirma dos veces.
create unique index if not exists uq_sales_lodging
  on public.sales (lodging_request_id) where lodging_request_id is not null;

-- ── 2. La conversión ──────────────────────────────────────────────────────
create or replace function public.crear_venta_desde_estadia(
  p_business_id uuid,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.lodging_requests%rowtype;
  v_sale_id uuid;
  v_nombre text;
begin
  select * into v_request
  from public.lodging_requests
  where id = p_request_id and business_id = p_business_id;
  if not found then
    return null;
  end if;

  select id into v_sale_id
  from public.sales
  where lodging_request_id = p_request_id and business_id = p_business_id;
  if found then
    return v_sale_id;
  end if;

  -- Solo cuenta lo confirmado. Una solicitud pendiente o rechazada no es
  -- dinero, igual que un pedido sin entregar.
  if v_request.status is distinct from 'confirmed' then
    return null;
  end if;
  if coalesce(v_request.total, 0) <= 0 then
    return null;
  end if;

  -- El nombre del ítem describe la estadía como la leería el dueño tres meses
  -- después: «Estadía 3 noches (2026-08-10 → 2026-08-13)».
  v_nombre := format(
    'Estadía %s noche%s (%s → %s)',
    v_request.nights,
    case when v_request.nights = 1 then '' else 's' end,
    v_request.check_in, v_request.check_out
  );

  insert into public.sales (
    business_id, lodging_request_id, contact_phone, contact_name,
    total, status, source, sold_at
  ) values (
    p_business_id, p_request_id, v_request.contact_phone, v_request.contact_name,
    v_request.total, 'completada', 'hospedaje',
    coalesce(v_request.confirmed_at, now())
  )
  returning id into v_sale_id;

  insert into public.sale_items (
    sale_id, business_id, product_id, product_name, quantity, unit_price, line_total
  ) values (
    -- Sin `product_id`: una habitación no vive en el catálogo de productos,
    -- vive en el inventario de hospedaje. Poner uno inventado ensuciaría
    -- «lo más vendido» con algo que no es un producto.
    v_sale_id, p_business_id, null, v_nombre, 1, v_request.total, v_request.total
  );

  return v_sale_id;
end;
$$;

revoke all on function public.crear_venta_desde_estadia(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.crear_venta_desde_estadia(uuid, uuid) to service_role;

-- ── 3. Confirmar la estadía registra su venta ─────────────────────────────
-- Se envuelve la función existente en vez de reescribirla: así no se toca ni
-- una línea del anti-sobreventa, que es lo delicado de este módulo.
create or replace function public.set_lodging_request_status_v2(
  p_business_id uuid,
  p_request_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_resultado jsonb;
begin
  v_resultado := public.set_lodging_request_status(p_business_id, p_request_id, p_status);

  -- Misma transacción: si la venta fallara, la estadía tampoco queda
  -- confirmada. Nunca hay una cosa sin la otra.
  if p_status = 'confirmed' and v_resultado ->> 'result' = 'updated' then
    perform public.crear_venta_desde_estadia(p_business_id, p_request_id);
  end if;

  return v_resultado;
end;
$$;

revoke all on function public.set_lodging_request_status_v2(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_lodging_request_status_v2(uuid, uuid, text) to service_role;

-- ── FRONTERAS DE LAS VENTAS ────────────────────────────────
-- Las claves foráneas de `sales` hacia pedidos, citas y estadías son
-- COMPUESTAS sobre (id, business_id): una simple solo comprueba que la fila
-- exista, no de quién es, y dejaba que una venta apuntara a algo de otro
-- negocio (migration-2026-08-02-fronteras-de-las-ventas.sql).
-- ── 1. Los destinos necesitan su índice único (id, business_id) ───────────
create unique index if not exists uq_orders_id_business
  on public.orders (id, business_id);
create unique index if not exists uq_bookings_id_business
  on public.bookings (id, business_id);
create unique index if not exists uq_lodging_requests_id_business
  on public.lodging_requests (id, business_id);

create or replace function public.claim_storefront_link_send(
  p_business_id uuid,
  p_customer_id uuid,
  p_cooldown_hours integer default 24
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reclamado boolean;
begin
  if p_business_id is null or p_customer_id is null then
    return false;
  end if;

  -- La fila de la relación puede no existir todavía si el cliente nunca pidió
  -- nada: se crea aquí para poder anotar el envío.
  insert into public.business_customers (business_id, customer_id)
  values (p_business_id, p_customer_id)
  on conflict (business_id, customer_id) do nothing;

  -- `for update` serializa a los mensajes que lleguen a la vez del mismo
  -- cliente. Sin esto, tres «hola» seguidos mandan tres enlaces.
  update public.business_customers
  set storefront_link_sent_at = now(),
      updated_at = now()
  where business_id = p_business_id
    and customer_id = p_customer_id
    and (
      storefront_link_sent_at is null
      or storefront_link_sent_at
         < now() - make_interval(hours => greatest(coalesce(p_cooldown_hours, 24), 0))
    )
  returning true into v_reclamado;

  return coalesce(v_reclamado, false);
end;
$$;

revoke all on function public.claim_storefront_link_send(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_storefront_link_send(uuid, uuid, integer)
  to service_role;

-- ════════════════════════════════════════════════════════════════════════
-- MOTOR DE GRUPOS DE OPCIONES
-- Convierte el catálogo en configuración: obligatoriedad, mínimos, selección
-- por cantidad y opciones que SON productos (los combos). Sin esto no existen
-- los almuerzos, las parrilladas ni los batidos
-- (migration-2026-08-04-motor-de-opciones.sql).
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. Los grupos ───────────────────────────────────────────────────────────
create table if not exists public.option_groups (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses(id) on delete cascade,
  -- El grupo cuelga de UN producto o de UNA categoría, nunca de ambos ni de
  -- ninguno (`option_groups_destino_check`, más abajo). Por categoría es como
  -- 19 sabores los comparten todas las pizzas sin repetirlos en cada una, y
  -- como una plantilla deja grupos cargados antes de que exista un solo
  -- producto (migration-2026-08-05-grupos-por-categoria.sql).
  product_id       uuid,
  category_id      uuid,
  name             text not null,
  description      text,
  -- Qué se puede hacer dentro del grupo. Son los tres selectores reales:
  --   single   → un radio. Tamaño de pizza, término de la carne.
  --   multiple → casillas con tope. Ingredientes, salsas.
  --   quantity → cada opción con su contador. Cortes de una parrillada.
  selection_type   text not null default 'single',
  required         boolean not null default false,
  min_selectable   integer not null default 0,
  max_selectable   integer not null default 1,
  sort             integer not null default 0,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint option_groups_datos_check check (
    char_length(btrim(name)) between 1 and 120
    and char_length(coalesce(description, '')) <= 300
    and selection_type in ('single', 'multiple', 'quantity')
    and min_selectable >= 0 and min_selectable <= 100
    and max_selectable >= 1 and max_selectable <= 100
    and min_selectable <= max_selectable
    -- Un grupo obligatorio sin mínimo no obliga a nada: sería un botón de
    -- «obligatorio» que no impide seguir, que es peor que no ponerlo.
    and (required = false or min_selectable >= 1)
    -- `single` es exactamente uno. Sin esto se podría guardar un radio con
    -- max 5, y la app tendría que decidir a quién cree.
    and (selection_type <> 'single' or max_selectable = 1)
    and sort between 0 and 999
  )
);

-- El producto se referencia por PAREJA (id, business_id), no solo por id.
-- Una foránea de una sola columna comprueba «esa fila existe», no «esa fila es
-- de este negocio», y como el negocio sale del JWT mientras el otro id viaja
-- en la petición, ahí se cruza la frontera mandando un uuid ajeno. Fue lo que
-- pasó con `product_variants` y `products.category_id` el 2026-08-02.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.option_groups'::regclass
      and conname = 'fk_option_groups_producto_del_negocio'
  ) then
    alter table public.option_groups
      add constraint fk_option_groups_producto_del_negocio
      foreign key (product_id, business_id)
      references public.products (id, business_id) on delete cascade;
  end if;
end $$;

create index if not exists idx_option_groups_producto
  on public.option_groups (business_id, product_id, sort);

-- El único (id, business_id) tiene que existir ANTES que la foránea compuesta
-- que lo usa como destino: PostgreSQL exige un único que case con la pareja.
create unique index if not exists uq_option_groups_id_business
  on public.option_groups (id, business_id);

-- ── 1 bis. El grupo también puede colgar de una categoría ───────────────────
-- Sobre una base creada con la versión anterior de esta tabla, `product_id`
-- sigue siendo NOT NULL y no existe `category_id`: estas tres sentencias la
-- ponen al día sin tocar los grupos que ya cuelgan de un producto.
alter table public.option_groups
  add column if not exists category_id uuid;
alter table public.option_groups
  alter column product_id drop not null;

-- Un grupo colgado de nada es invisible y vive igual; colgado de las dos cosas
-- obliga a la app a decidir cuál manda. Exactamente uno.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.option_groups'::regclass
      and conname = 'option_groups_destino_check'
  ) then
    alter table public.option_groups
      add constraint option_groups_destino_check
      check (num_nonnulls(product_id, category_id) = 1);
  end if;
end $$;

-- La categoría se referencia por PAREJA, como el producto. Va en CASCADE y no
-- en `set null` porque el check de arriba lo exige: anular `category_id`
-- dejaría el grupo sin destino y borrar una categoría reventaría.
--
-- El único (id, business_id) que esta foránea necesita como destino ya lo crea
-- `product_categories` mucho más arriba, así que aquí no se repite.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.option_groups'::regclass
      and conname = 'fk_option_groups_categoria_del_negocio'
  ) then
    alter table public.option_groups
      add constraint fk_option_groups_categoria_del_negocio
      foreign key (category_id, business_id)
      references public.product_categories (id, business_id) on delete cascade;
  end if;
end $$;

create index if not exists idx_option_groups_categoria
  on public.option_groups (business_id, category_id, sort);

-- ════════════════════════════════════════════════════════════════════════
-- MOTOR UNIVERSAL DE PRODUCTOS
-- Tipos de producto, estrategias de precio y plantillas reutilizables. Es lo
-- que permite que la misma app sirva a una pizzería, una heladería y un local
-- de almuerzos sin tocar código: la diferencia sale de la CONFIGURACIÓN
-- (migration-2026-08-05-motor-de-productos.sql).
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. La clase de producto ─────────────────────────────────────────────────
alter table public.products
  add column if not exists product_type text not null default 'simple';
alter table public.products
  add column if not exists preparation_time integer;
alter table public.products
  add column if not exists featured boolean not null default false;
alter table public.products
  add column if not exists popular boolean not null default false;
alter table public.products
  add column if not exists sort integer not null default 0;
-- Stock por unidades, para quien lo lleve. `stock` (texto) sigue mandando
-- cuando esto está apagado: no se toca lo que ya funciona.
alter table public.products
  add column if not exists stock_control_enabled boolean not null default false;
alter table public.products
  add column if not exists stock_quantity integer;
alter table public.products
  add column if not exists min_quantity integer not null default 1;
alter table public.products
  add column if not exists max_quantity integer not null default 99;
-- Disponibilidad por día y hora: el almuerzo del día, el desayuno hasta las 11.
alter table public.products
  add column if not exists available_days smallint[];
alter table public.products
  add column if not exists available_from time;
alter table public.products
  add column if not exists available_until time;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.products'::regclass and conname = 'products_motor_check'
  ) then
    alter table public.products add constraint products_motor_check check (
      product_type in ('simple', 'configurable', 'combo', 'daily_menu', 'weighted')
      and (preparation_time is null or preparation_time between 0 and 1440)
      and (stock_quantity is null or stock_quantity >= 0)
      and min_quantity between 1 and 99
      and max_quantity between 1 and 99
      and min_quantity <= max_quantity
      and sort between 0 and 9999
      -- Un día fuera de 0..6 no lo entiende nadie, y dejaría el producto
      -- invisible sin decir por qué.
      and (available_days is null or (
        array_length(available_days, 1) between 1 and 7
        and available_days <@ array[0,1,2,3,4,5,6]::smallint[]
      ))
    );
  end if;
end $$;

create index if not exists idx_products_tipo
  on public.products (business_id, product_type) where active;

-- ── 2. Cómo se cobra un grupo ───────────────────────────────────────────────
alter table public.option_groups
  add column if not exists pricing_strategy text not null default 'sum';
-- Cuántas selecciones van sin recargo antes de empezar a cobrar.
alter table public.option_groups
  add column if not exists free_selections integer not null default 0;
-- Tope de porciones del grupo entero en los contadores, cuando el tope por
-- opción no basta: «4 porciones» repartidas como se quiera.
alter table public.option_groups
  add column if not exists max_total_quantity integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.option_groups'::regclass
      and conname = 'option_groups_precio_check'
  ) then
    alter table public.option_groups add constraint option_groups_precio_check check (
      pricing_strategy in (
        'sum', 'fixed', 'highest_selected', 'lowest_selected', 'average',
        'included', 'included_up_to_limit', 'extra_after_limit'
      )
      and free_selections between 0 and 100
      and (max_total_quantity is null or max_total_quantity between 1 and 100)
      -- Las dos estrategias con límite necesitan saber cuál es. Sin esto, un
      -- «las primeras N gratis» con N=0 cobraría todo y nadie sabría por qué.
      and (
        pricing_strategy not in ('included_up_to_limit', 'extra_after_limit')
        or free_selections >= 1
      )
    );
  end if;
end $$;

-- ── 3. Plantillas de opciones reutilizables ─────────────────────────────────
create table if not exists public.option_templates (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name        text not null,
  description text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint option_templates_datos_check check (
    char_length(btrim(name)) between 1 and 120
    and char_length(coalesce(description, '')) <= 300
  )
);

create index if not exists idx_option_templates_negocio
  on public.option_templates (business_id, name);
-- El único (id, business_id) va ANTES que cualquier foránea compuesta que lo
-- use como destino: PostgreSQL exige un único que case con la pareja.
create unique index if not exists uq_option_templates_id_business
  on public.option_templates (id, business_id);
create unique index if not exists uq_option_templates_nombre
  on public.option_templates (business_id, lower(btrim(name)));

create table if not exists public.option_template_items (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses(id) on delete cascade,
  option_template_id    uuid not null,
  name                  text not null,
  description           text,
  image_url             text,
  image_public_id       text,
  price_adjustment      numeric(10,2) not null default 0,
  references_product_id uuid,
  default_selected      boolean not null default false,
  stock                 text not null default 'disponible',
  sort                  integer not null default 0,
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint option_template_items_datos_check check (
    char_length(btrim(name)) between 1 and 120
    and char_length(coalesce(description, '')) <= 300
    and price_adjustment >= -100000 and price_adjustment <= 100000
    and stock in ('disponible', 'agotado')
    and sort between 0 and 999
    and (image_url is null or image_url ~ '^https://')
  )
);

-- Las dos foráneas van por PAREJA (id, business_id). Una de una sola columna
-- comprueba «esa fila existe», no «esa fila es de este negocio», y ahí es por
-- donde se cruzó la frontera con `product_variants` el 2026-08-02.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.option_template_items'::regclass
      and conname = 'fk_option_template_items_plantilla_del_negocio'
  ) then
    alter table public.option_template_items
      add constraint fk_option_template_items_plantilla_del_negocio
      foreign key (option_template_id, business_id)
      references public.option_templates (id, business_id) on delete cascade;
  end if;

  -- Una plantilla de «sabores» puede apuntar a productos reales del catálogo:
  -- así los combos eligen pizzas de verdad. `set null` con la columna NOMBRADA,
  -- porque sin nombrarla PostgreSQL anularía también `business_id`, que es NOT
  -- NULL, y borrar un producto reventaría. Es el fallo del 2026-08-02.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.option_template_items'::regclass
      and conname = 'fk_option_template_items_producto_del_negocio'
  ) then
    alter table public.option_template_items
      add constraint fk_option_template_items_producto_del_negocio
      foreign key (references_product_id, business_id)
      references public.products (id, business_id)
      on delete set null (references_product_id);
  end if;
end $$;

create index if not exists idx_option_template_items_plantilla
  on public.option_template_items (business_id, option_template_id, sort);

-- El grupo que se sirve de una plantilla en vez de tener opciones propias.
alter table public.option_groups
  add column if not exists option_template_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.option_groups'::regclass
      and conname = 'fk_option_groups_plantilla_del_negocio'
  ) then
    alter table public.option_groups
      add constraint fk_option_groups_plantilla_del_negocio
      foreign key (option_template_id, business_id)
      references public.option_templates (id, business_id)
      on delete set null (option_template_id);
  end if;
end $$;

-- ── 4. RLS ──────────────────────────────────────────────────────────────────
alter table public.option_templates enable row level security;
alter table public.option_template_items enable row level security;
revoke all on table public.option_templates from public, anon, authenticated;
revoke all on table public.option_template_items from public, anon, authenticated;
grant select, insert, update, delete on table public.option_templates to service_role;
grant select, insert, update, delete on table public.option_template_items to service_role;

-- ── 2. Las opciones ─────────────────────────────────────────────────────────
create table if not exists public.options (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses(id) on delete cascade,
  option_group_id       uuid not null,
  name                  text not null,
  description           text,
  image_url             text,
  image_public_id       text,
  -- Puede ser NEGATIVO: «sin sopa −$0.50» en un almuerzo es un caso real.
  -- Por eso el importe final lo calcula PostgreSQL y nunca el navegador.
  price_adjustment      numeric(10,2) not null default 0,
  -- Aquí viven los COMBOS: una opción que ES un producto del catálogo.
  -- «Elige tu 1era pizza» son opciones que apuntan a pizzas reales, en vez de
  -- columnas fijas tipo pizza_1, pizza_2.
  references_product_id uuid,
  default_selected      boolean not null default false,
  stock                 text not null default 'disponible',
  sort                  integer not null default 0,
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint options_datos_check check (
    char_length(btrim(name)) between 1 and 120
    and char_length(coalesce(description, '')) <= 300
    and price_adjustment >= -100000 and price_adjustment <= 100000
    and stock in ('disponible', 'agotado')
    and sort between 0 and 999
    and (image_url is null or image_url ~ '^https://')
  )
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.options'::regclass
      and conname = 'fk_options_grupo_del_negocio'
  ) then
    alter table public.options
      add constraint fk_options_grupo_del_negocio
      foreign key (option_group_id, business_id)
      references public.option_groups (id, business_id) on delete cascade;
  end if;

  -- El producto referenciado también tiene que ser de ESTE negocio: si no, un
  -- combo podría incluir la pizza del local de al lado.
  --
  -- `on delete set null (references_product_id)` con la columna NOMBRADA: sin
  -- nombrarla PostgreSQL anularía también `business_id`, que es NOT NULL, y
  -- borrar un producto reventaría. Es exactamente el fallo del 2026-08-02.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.options'::regclass
      and conname = 'fk_options_producto_del_negocio'
  ) then
    alter table public.options
      add constraint fk_options_producto_del_negocio
      foreign key (references_product_id, business_id)
      references public.products (id, business_id)
      on delete set null (references_product_id);
  end if;
end $$;

create index if not exists idx_options_grupo
  on public.options (business_id, option_group_id, sort);

-- ── «Agrega algo más»: los adicionales independientes ───────────────────
-- Un adicional NO es un complemento incluido: la bebida de un combo vive
-- dentro de su línea, y el pan de ajo que se suma al final es OTRO producto
-- con su propia línea del carrito. Si acabaran juntos, el dueño vería «Pizza
-- (con Coca Cola)» en vez de dos cosas que preparar
-- (migration-2026-08-05-adicionales.sql).
-- Las tres foráneas necesitan que existan los únicos (id, business_id) de sus
-- destinos. En `schema.sql` este bloque va ANTES de donde se crean, así que se
-- aseguran aquí: PostgreSQL exige un único que case con la pareja.
create unique index if not exists uq_products_id_business
  on public.products (id, business_id);
create unique index if not exists uq_product_categories_id_business
  on public.product_categories (id, business_id);

create table if not exists public.product_recommendations (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses(id) on delete cascade,
  -- De dónde sale la sugerencia. Ambos nulos = de todo el negocio.
  source_product_id      uuid,
  source_category_id     uuid,
  -- Qué se ofrece. Es un producto de verdad del catálogo.
  recommended_product_id uuid not null,
  -- El título de la sección: «Agrega bebidas», «También te puede gustar».
  section                text not null default 'Agrega algo más',
  sort                   integer not null default 0,
  active                 boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint product_recommendations_datos_check check (
    char_length(btrim(section)) between 1 and 60
    and sort between 0 and 999
    and num_nonnulls(source_product_id, source_category_id) <= 1
  )
);

-- Las tres foráneas van por PAREJA (id, business_id). Sin el negocio dentro,
-- una recomendación podría ofrecer el producto de OTRO local — y ese sí que
-- acabaría en el carrito, porque un adicional es una línea de verdad.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.product_recommendations'::regclass
      and conname = 'fk_recomendaciones_producto_origen'
  ) then
    alter table public.product_recommendations
      add constraint fk_recomendaciones_producto_origen
      foreign key (source_product_id, business_id)
      references public.products (id, business_id) on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.product_recommendations'::regclass
      and conname = 'fk_recomendaciones_categoria_origen'
  ) then
    alter table public.product_recommendations
      add constraint fk_recomendaciones_categoria_origen
      foreign key (source_category_id, business_id)
      references public.product_categories (id, business_id) on delete cascade;
  end if;

  -- Si el producto ofrecido desaparece, la recomendación se va con él: dejarla
  -- viva ofrecería algo que ya no se puede pedir.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.product_recommendations'::regclass
      and conname = 'fk_recomendaciones_producto_ofrecido'
  ) then
    alter table public.product_recommendations
      add constraint fk_recomendaciones_producto_ofrecido
      foreign key (recommended_product_id, business_id)
      references public.products (id, business_id) on delete cascade;
  end if;
end $$;

create index if not exists idx_recomendaciones_origen
  on public.product_recommendations (business_id, source_product_id, sort);
create index if not exists idx_recomendaciones_categoria
  on public.product_recommendations (business_id, source_category_id, sort);

-- Ofrecer dos veces lo mismo en el mismo sitio es un descuido, no una
-- intención: el cliente vería el pan de ajo repetido.
create unique index if not exists uq_recomendaciones_sin_repetir
  on public.product_recommendations (
    business_id,
    coalesce(source_product_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(source_category_id, '00000000-0000-0000-0000-000000000000'::uuid),
    recommended_product_id
  );

alter table public.product_recommendations enable row level security;
revoke all on table public.product_recommendations from public, anon, authenticated;
grant select, insert, update, delete on table public.product_recommendations to service_role;

-- ── 3. Qué eligió el cliente, guardado con el pedido ────────────────────────
-- Fotografía inmutable: si mañana cambia el nombre o el recargo de la opción,
-- el pedido de ayer tiene que seguir diciendo lo que se pidió y lo que costó.
create table if not exists public.order_item_options (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses(id) on delete cascade,
  order_item_id          uuid not null references public.order_items(id) on delete cascade,
  option_group_id        uuid,
  option_id              uuid,
  option_group_name      text not null,
  option_name            text not null,
  quantity               integer not null default 1,
  unit_price_adjustment  numeric(10,2) not null default 0,
  total_price_adjustment numeric(10,2) not null default 0,
  created_at             timestamptz not null default now(),
  constraint order_item_options_datos_check check (
    char_length(btrim(option_group_name)) between 1 and 120
    and char_length(btrim(option_name)) between 1 and 120
    and quantity between 1 and 100
  )
);

create index if not exists idx_order_item_options_item
  on public.order_item_options (business_id, order_item_id);

-- `order_item_options` apunta al ítem del pedido, y ambos llevan business_id:
-- con una foránea de una sola columna se podría colgar el detalle de lo que
-- eligió un cliente sobre el ítem de OTRO negocio. Lo cazó
-- `verificar-fronteras.sql` al escribir esta migración, que es justo para lo
-- que se construyó.
create unique index if not exists uq_order_items_id_business
  on public.order_items (id, business_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_item_options'::regclass
      and conname = 'fk_order_item_options_item_del_negocio'
  ) then
    alter table public.order_item_options
      drop constraint if exists order_item_options_order_item_id_fkey;
    alter table public.order_item_options
      add constraint fk_order_item_options_item_del_negocio
      foreign key (order_item_id, business_id)
      references public.order_items (id, business_id) on delete cascade;
  end if;
end $$;


-- ── 4. RLS ──────────────────────────────────────────────────────────────────
-- El frontend nunca habla con Supabase: la anon key queda bloqueada y el
-- aislamiento real lo refuerza el filtrado por business_id en server/src/db.
alter table public.option_groups enable row level security;
alter table public.options enable row level security;
alter table public.order_item_options enable row level security;

revoke all on table public.option_groups from public, anon, authenticated;
revoke all on table public.options from public, anon, authenticated;
revoke all on table public.order_item_options from public, anon, authenticated;
grant select, insert, update, delete on table public.option_groups to service_role;
grant select, insert, update, delete on table public.options to service_role;
grant select, insert, update, delete on table public.order_item_options to service_role;

-- ── 5. La plantilla del tipo de negocio ─────────────────────────────────────
-- Deja cargadas las categorías y los grupos típicos de un negocio recién
-- creado: lo que convierte «dar de alta una hamburguesería» en cargar datos.
-- No sobrescribe (si ya hay catálogo no toca nada), es todo o nada, y sus
-- grupos cuelgan de la CATEGORÍA, que es lo que permite cargarlos cuando el
-- negocio todavía no tiene ni un producto
-- (migration-2026-08-05-plantillas-de-negocio.sql).
create or replace function public.apply_business_template(
  p_business_id uuid,
  p_template jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_categoria jsonb;
  v_grupo jsonb;
  v_opcion jsonb;
  v_categoria_id uuid;
  v_grupo_id uuid;
  v_categorias integer := 0;
  v_grupos integer := 0;
  v_opciones integer := 0;
begin
  if p_business_id is null then
    raise exception 'Falta el negocio' using errcode = '22023';
  end if;

  if not exists (select 1 from businesses where id = p_business_id) then
    raise exception 'El negocio no existe' using errcode = '42501';
  end if;

  -- El portón: un negocio con catálogo ya es un negocio con decisiones
  -- tomadas, y una plantilla encima las pisaría.
  if exists (select 1 from product_categories where business_id = p_business_id)
     or exists (select 1 from products where business_id = p_business_id) then
    return jsonb_build_object(
      'aplicada', false,
      'motivo', 'El negocio ya tiene catálogo',
      'categorias', 0, 'grupos', 0, 'opciones', 0
    );
  end if;

  for v_categoria in
    select * from jsonb_array_elements(coalesce(p_template->'categorias', '[]'::jsonb))
  loop
    insert into product_categories (business_id, name, sort)
    values (
      p_business_id,
      v_categoria->>'nombre',
      coalesce((v_categoria->>'orden')::integer, 0)
    )
    returning id into v_categoria_id;
    v_categorias := v_categorias + 1;

    for v_grupo in
      select * from jsonb_array_elements(coalesce(v_categoria->'grupos', '[]'::jsonb))
    loop
      insert into option_groups (
        business_id, category_id, product_id, name, selection_type,
        required, min_selectable, max_selectable, sort
      ) values (
        p_business_id,
        v_categoria_id,
        null,
        v_grupo->>'nombre',
        coalesce(v_grupo->>'tipo', 'single'),
        coalesce((v_grupo->>'obligatorio')::boolean, false),
        coalesce((v_grupo->>'min')::integer, 0),
        coalesce((v_grupo->>'max')::integer, 1),
        coalesce((v_grupo->>'orden')::integer, 0)
      )
      returning id into v_grupo_id;
      v_grupos := v_grupos + 1;

      for v_opcion in
        select * from jsonb_array_elements(coalesce(v_grupo->'opciones', '[]'::jsonb))
      loop
        insert into options (
          business_id, option_group_id, name, price_adjustment, sort
        ) values (
          p_business_id,
          v_grupo_id,
          v_opcion->>'nombre',
          coalesce((v_opcion->>'recargo')::numeric, 0),
          coalesce((v_opcion->>'orden')::integer, 0)
        );
        v_opciones := v_opciones + 1;
      end loop;
    end loop;
  end loop;

  return jsonb_build_object(
    'aplicada', true,
    'categorias', v_categorias,
    'grupos', v_grupos,
    'opciones', v_opciones
  );
end;
$$;

revoke all on function public.apply_business_template(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_business_template(uuid, jsonb)
  to service_role;

-- ── 2. Las ventas solo pueden apuntar a algo de SU negocio ────────────────
--
-- Las tres nacieron con `on delete set null` a secas y eso anulaba también
-- `business_id`, que es NOT NULL: borrar un pedido entregado o una cita
-- atendida reventaba con 23502. En una base que ya las tiene mal, el
-- `if not exists` de abajo no las arreglaría, así que primero se retiran las
-- que sigan en la forma rota (migration-2026-08-02-borrado-de-ventas.sql).
do $$
declare
  v_rota text;
begin
  for v_rota in
    select conname from pg_constraint
    where conrelid = 'public.sales'::regclass
      and contype = 'f'
      and conname in (
        'fk_sales_pedido_del_negocio',
        'fk_sales_cita_del_negocio',
        'fk_sales_estadia_del_negocio'
      )
      and pg_get_constraintdef(oid) !~ 'ON DELETE SET NULL \('
  loop
    execute format('alter table public.sales drop constraint %I', v_rota);
  end loop;
end;
$$;

do $$
begin
  -- La foránea simple se retira: dejarla viva permitiría el cruce igual.
  alter table public.sales drop constraint if exists sales_order_id_fkey;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sales'::regclass and conname = 'fk_sales_pedido_del_negocio'
  ) then
    -- `set null (order_id)` y no `set null` a secas: sin nombrar la columna
    -- PostgreSQL anularía también `business_id`, que es NOT NULL, y borrar un
    -- pedido entregado reventaría (migration-2026-08-02-borrado-de-ventas.sql).
    alter table public.sales
      add constraint fk_sales_pedido_del_negocio
      foreign key (order_id, business_id)
      references public.orders (id, business_id)
      on delete set null (order_id);
  end if;

  alter table public.sales drop constraint if exists sales_booking_id_fkey;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sales'::regclass and conname = 'fk_sales_cita_del_negocio'
  ) then
    alter table public.sales
      add constraint fk_sales_cita_del_negocio
      foreign key (booking_id, business_id)
      references public.bookings (id, business_id)
      on delete set null (booking_id);
  end if;

  alter table public.sales drop constraint if exists sales_lodging_request_id_fkey;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sales'::regclass and conname = 'fk_sales_estadia_del_negocio'
  ) then
    alter table public.sales
      add constraint fk_sales_estadia_del_negocio
      foreign key (lodging_request_id, business_id)
      references public.lodging_requests (id, business_id)
      on delete set null (lodging_request_id);
  end if;
end;
$$;

-- ── 3. La cita ya tenía su foránea compuesta, pero la simple seguía viva ──
-- `add column ... references products(id)` la creó sola, y mientras exista el
-- cruce sigue siendo posible por ella.
alter table public.bookings drop constraint if exists bookings_product_id_fkey;

-- ── RED DE SEGURIDAD: RLS AUTOMÁTICA EN TABLAS NUEVAS ──────
-- Existía en la base de producción pero NO en este archivo, así que una
-- instalación nueva nacía sin ella: es justo el tipo de deriva que el
-- detector de funciones huérfanas viene a evitar (encontrada 2026-08-02).
--
-- Qué hace: cada vez que se crea una tabla en `public`, le activa RLS sola.
-- La regla #1 del proyecto es que toda tabla de negocio nazca con RLS, y esto
-- la cumple aunque a alguien se le olvide escribirlo en su migración.
--
-- ⚠️ Crear disparadores de EVENTO exige superusuario. En Supabase y en el CI
-- se puede; en una base donde no, el bloque se salta sin romper el resto — el
-- esquema sigue declarando el `enable row level security` de cada tabla.
do $$
begin
  create or replace function public.rls_auto_enable()
  returns event_trigger
  language plpgsql
  security definer
  set search_path to 'pg_catalog'
  as $funcion$
  declare
    cmd record;
  begin
    for cmd in
      select *
      from pg_event_trigger_ddl_commands()
      where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
        and object_type in ('table', 'partitioned table')
    loop
      if cmd.schema_name = 'public' then
        begin
          execute format('alter table if exists %s enable row level security', cmd.object_identity);
        exception when others then
          raise log 'rls_auto_enable: no se pudo activar RLS en %', cmd.object_identity;
        end;
      end if;
    end loop;
  end;
  $funcion$;

  if not exists (select 1 from pg_event_trigger where evtname = 'ensure_rls') then
    create event trigger ensure_rls on ddl_command_end
      when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      execute function public.rls_auto_enable();
  end if;
exception when insufficient_privilege then
  raise notice 'Sin permisos para el disparador de eventos ensure_rls; se omite.';
end;
$$;

-- ============================================================
-- BOTPANEL SAAS — Schema COMPLETO y ACTUALIZADO para Supabase
--
-- Refleja el estado REAL de la base de datos (consolidado).
-- Idempotente: seguro de correr en una base nueva o existente.
--
-- INSTRUCCIONES:
--   Supabase → tu proyecto → SQL Editor → New query → pega TODO → RUN
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
                      check (chat_mode in ('menu','ai')),
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
  status           text not null default 'pendiente'
                   check (status in ('pendiente','confirmado','completado','cancelado','expirado')),
  subtotal         numeric(10,2) not null default 0,
  discount         numeric(10,2) not null default 0,  -- solo por código/panel, jamás la IA
  total            numeric(10,2) not null default 0,
  currency         text not null default 'USD',
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

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

-- ── ÍNDICES ────────────────────────────────────────────────
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
create or replace function public.create_order_with_items(
  p_business_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_status text,
  p_discount numeric,
  p_currency text,
  p_items jsonb
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
    if v_requested_price is distinct from v_unit_price then
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
    subtotal, discount, total, currency
  ) values (
    p_business_id, btrim(p_contact_phone), nullif(btrim(p_contact_name), ''),
    coalesce(p_status, 'pendiente'), v_subtotal, v_discount, v_total,
    coalesce(nullif(btrim(p_currency), ''), 'USD')
  ) returning * into v_order;

  insert into order_items (
    order_id, business_id, product_id, product_name, quantity, unit_price, line_total
  )
  select
    v_order.id, p_business_id, nullif(item ->> 'product_id', '')::uuid,
    item ->> 'product_name', (item ->> 'quantity')::integer,
    (item ->> 'unit_price')::numeric, (item ->> 'line_total')::numeric
  from jsonb_array_elements(v_normalized_items) as item;

  return to_jsonb(v_order);
end;
$$;

revoke all on function public.create_order_with_items(uuid, text, text, text, numeric, text, jsonb) from public;
revoke all on function public.create_order_with_items(uuid, text, text, text, numeric, text, jsonb) from anon;
revoke all on function public.create_order_with_items(uuid, text, text, text, numeric, text, jsonb) from authenticated;
grant execute on function public.create_order_with_items(uuid, text, text, text, numeric, text, jsonb) to service_role;

-- Cambia el ciclo de vida de un pedido de forma atómica. Los estados finales
-- no pueden reabrirse y repetir el mismo cambio es seguro.
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
begin
  if p_status not in ('confirmado', 'completado', 'cancelado', 'expirado') then
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

  if not (
    (v_order.status = 'pendiente' and p_status in ('confirmado', 'cancelado', 'expirado'))
    or (v_order.status = 'confirmado' and p_status in ('completado', 'cancelado', 'expirado'))
  ) then
    return jsonb_build_object('result', 'invalid_transition', 'order', to_jsonb(v_order));
  end if;

  update public.orders
  set status = p_status, updated_at = now()
  where id = p_order_id and business_id = p_business_id
  returning * into v_order;

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

-- ── FUNCIÓN ATÓMICA: venta manual + detalles ──────────────
-- Una excepción en cualquier validación/insert revierte la venta completa.
create or replace function public.create_sale_with_items(
  p_business_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_created_by uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_sale sales%rowtype;
  v_item jsonb;
  v_product_id uuid;
  v_product_name text;
  v_product_stock text;
  v_quantity integer;
  v_unit_price numeric(10,2);
  v_line_total numeric(10,2);
  v_total numeric(10,2) := 0;
begin
  if p_business_id is null then
    raise exception using errcode = '22023', message = 'El negocio es obligatorio';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'La venta necesita al menos un ítem';
  end if;
  if p_created_by is not null and not exists (
    select 1 from client_users cu
    where cu.id = p_created_by and cu.business_id = p_business_id
  ) then
    raise exception using errcode = '42501', message = 'El usuario no pertenece al negocio';
  end if;

  insert into sales (
    business_id, contact_phone, contact_name, total, status, source, created_by
  ) values (
    p_business_id, nullif(btrim(p_contact_phone), ''),
    nullif(btrim(p_contact_name), ''), 0, 'completada', 'manual', p_created_by
  ) returning * into v_sale;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Cada ítem debe ser un objeto';
    end if;
    v_product_id := nullif(v_item ->> 'product_id', '')::uuid;
    v_quantity := (v_item ->> 'quantity')::integer;
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

    v_line_total := round(v_quantity * v_unit_price, 2);
    v_total := v_total + v_line_total;
    insert into sale_items (
      sale_id, business_id, product_id, product_name, quantity, unit_price, line_total
    ) values (
      v_sale.id, p_business_id, v_product_id, v_product_name,
      v_quantity, v_unit_price, v_line_total
    );
  end loop;

  update sales
  set total = round(v_total, 2)
  where id = v_sale.id and business_id = p_business_id
  returning * into v_sale;
  return to_jsonb(v_sale);
end;
$$;

revoke all on function public.create_sale_with_items(uuid, text, text, uuid, jsonb) from public;
revoke all on function public.create_sale_with_items(uuid, text, text, uuid, jsonb) from anon;
revoke all on function public.create_sale_with_items(uuid, text, text, uuid, jsonb) from authenticated;
grant execute on function public.create_sale_with_items(uuid, text, text, uuid, jsonb) to service_role;

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
  v_inserted integer;
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
     or pg_column_size(p_payload) > 262144 then
    raise exception using errcode = '22023', message = 'Payload de webhook invalido';
  end if;

  insert into public.webhook_inbound_events (
    business_id, provider, message_id_hash, stream_key_hash,
    payload_version, payload, status, attempts, max_attempts,
    available_at, completed_at, dead_at, updated_at
  ) values (
    p_business_id, p_provider, p_message_id_hash, p_stream_key_hash,
    1, p_payload, 'pending', 0, 8,
    now(), null, null, now()
  )
  on conflict (business_id, provider, message_id_hash) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
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
begin
  if nullif(btrim(p_worker_id), '') is null
     or char_length(p_worker_id) > 128 then
    raise exception using errcode = '22023', message = 'Worker ID invalido';
  end if;

  update public.webhook_inbound_events as event
  set status = 'dead',
      lease_token = null,
      lease_owner = null,
      leased_until = null,
      dead_at = now(),
      last_error = coalesce(
        event.last_error,
        'Lease vencido despues del ultimo intento'
      ),
      updated_at = now()
  where event.status = 'processing'
    and event.leased_until <= now()
    and event.attempts >= event.max_attempts;

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

  return query
  with candidates as (
    select event.id
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
          and (earlier.received_at, earlier.id) < (event.received_at, event.id)
      )
    order by event.received_at, event.id
    for update of event skip locked
    limit v_limit
  ), leased_rows as (
    update public.webhook_inbound_events as event
    set status = 'processing',
        attempts = event.attempts + 1,
        lease_token = gen_random_uuid(),
        lease_owner = btrim(p_worker_id),
        leased_until = now() + make_interval(secs => v_lease_seconds),
        updated_at = now()
    from candidates
    where event.id = candidates.id
    returning
      event.id as leased_id,
      event.business_id as leased_business_id,
      event.provider as leased_provider,
      event.payload as leased_payload,
      event.lease_token as leased_token,
      event.attempts as leased_attempts
  )
  select
    leased_rows.leased_id,
    leased_rows.leased_business_id,
    leased_rows.leased_provider,
    leased_rows.leased_payload,
    leased_rows.leased_token,
    leased_rows.leased_attempts
  from leased_rows;
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
  v_completed integer;
begin
  if p_event_id is null or p_lease_token is null then return false; end if;

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
  v_attempts integer;
  v_max_attempts integer;
  v_base_delay integer := greatest(
    1, least(coalesce(p_base_delay_seconds, 5), 300)
  );
  v_delay_seconds integer;
  v_error text := left(
    coalesce(nullif(btrim(p_error), ''), 'Error de procesamiento'),
    2000
  );
begin
  if p_event_id is null or p_lease_token is null then return 'stale'; end if;

  select event.attempts, event.max_attempts
  into v_attempts, v_max_attempts
  from public.webhook_inbound_events as event
  where event.id = p_event_id
    and event.status = 'processing'
    and event.lease_token = p_lease_token
  for update;

  if not found then return 'stale'; end if;

  if v_attempts >= v_max_attempts then
    update public.webhook_inbound_events as event
    set status = 'dead',
        lease_token = null,
        lease_owner = null,
        leased_until = null,
        last_error = v_error,
        dead_at = now(),
        updated_at = now()
    where event.id = p_event_id
      and event.status = 'processing'
      and event.lease_token = p_lease_token;
    return 'dead';
  end if;

  v_delay_seconds := least(
    900,
    v_base_delay
      * power(2::numeric, least(greatest(v_attempts - 1, 0), 10))::integer
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

-- ── ROW LEVEL SECURITY (RLS) ───────────────────────────────
-- RLS ACTIVADO en todas las tablas. El backend usa la SERVICE KEY
-- (la bypassa); el aislamiento real lo refuerza el filtrado por
-- business_id en db.js. La anon key del frontend queda BLOQUEADA
-- (no lee datos directo) → por eso el frontend usa polling vía API.
alter table businesses            enable row level security;
alter table business_channel_identifiers enable row level security;
alter table client_users          enable row level security;
alter table products              enable row level security;
alter table bot_policies          enable row level security;
alter table conversation_history  enable row level security;
alter table conversation_sessions enable row level security;
alter table conversation_tags     enable row level security;
alter table business_schedule     enable row level security;
alter table bookings              enable row level security;
alter table billing               enable row level security;
alter table server_settings       enable row level security;
alter table sales                 enable row level security;
alter table sale_items            enable row level security;
alter table product_consultations enable row level security;
alter table ai_gaps               enable row level security;
alter table orders                enable row level security;
alter table order_items           enable row level security;
alter table webhook_inbound_events enable row level security;

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

-- ============================================================================
-- CLIENTES Y SESIONES DE LA TIENDA
--
-- La mini app no tiene registro ni contraseña: el cliente ya se identificó al
-- escribir por WhatsApp. El bot le manda un enlace con un token y ese token ES
-- su sesión.
--
-- La tienda NO es pública: sin token válido no se entra. Quien reciba un enlace
-- reenviado tendrá que escribir al negocio para obtener el suyo — lo que
-- convierte un reenvío en un cliente nuevo en vez de en una fuga.
--
-- El cliente se guarda como identidad GLOBAL (una persona, un teléfono) con una
-- relación por negocio. Así el día que exista el marketplace no hay que rehacer
-- nada, y mientras tanto cada negocio solo ve su propia relación: nunca sabe
-- que ese teléfono también compra en otro sitio.
--
-- Idempotente. Correr en Supabase → SQL Editor.
-- ============================================================================

begin;

-- ── 1. Identidad global del cliente ─────────────────────────────────────────
-- Deliberadamente mínima: aquí NO va nada que un negocio no deba ver de otro.
-- WhatsApp es hoy el único método de identificación, pero la tabla no lo asume
-- para no cerrar la puerta a otros mañana.
create table if not exists public.customers (
  id         uuid primary key default gen_random_uuid(),
  phone      text not null,
  name       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.customers'::regclass
      and conname = 'customers_datos_check'
  ) then
    alter table public.customers
      add constraint customers_datos_check
      check (
        phone ~ '^[0-9]{8,15}$'
        and char_length(coalesce(name, '')) <= 120
      );
  end if;
end;
$$;

create unique index if not exists uq_customers_phone
  on public.customers (phone);

alter table public.customers enable row level security;


-- ── 2. Relación cliente ↔ negocio ───────────────────────────────────────────
-- Lo que cada negocio SÍ puede ver de su cliente. Un negocio jamás consulta
-- `customers` directamente: entra por aquí, filtrando por su business_id.
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
  updated_at        timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.business_customers'::regclass
      and conname = 'business_customers_datos_check'
  ) then
    alter table public.business_customers
      add constraint business_customers_datos_check
      check (
        total_orders >= 0
        and total_spent >= 0
        and char_length(coalesce(display_name, '')) <= 120
        and char_length(coalesce(notes, '')) <= 500
      );
  end if;
end;
$$;

create unique index if not exists uq_business_customers
  on public.business_customers (business_id, customer_id);
create index if not exists idx_business_customers_recientes
  on public.business_customers (business_id, last_order_at desc);

alter table public.business_customers enable row level security;


-- ── 3. Direcciones guardadas ────────────────────────────────────────────────
-- Se guardan POR NEGOCIO a propósito: que una pizzería vea a dónde pidió ese
-- cliente en otro local sería filtrar datos entre negocios. El coste es que la
-- primera vez en cada negocio hay que escribirla; a partir de ahí, un toque.
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
  updated_at  timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.customer_addresses'::regclass
      and conname = 'customer_addresses_datos_check'
  ) then
    alter table public.customer_addresses
      add constraint customer_addresses_datos_check
      check (
        char_length(btrim(label)) between 1 and 40
        and char_length(btrim(address)) between 1 and 300
        and char_length(coalesce(reference, '')) <= 300
        and (latitude is null or latitude between -90 and 90)
        and (longitude is null or longitude between -180 and 180)
      );
  end if;
end;
$$;

create index if not exists idx_customer_addresses_cliente
  on public.customer_addresses (business_id, customer_id, active);

alter table public.customer_addresses enable row level security;


-- ── 4. Sesiones de la tienda ────────────────────────────────────────────────
-- El enlace que manda el bot. Se guarda el HASH del token, nunca el token: si
-- alguien lee la base, no puede entrar en la tienda de nadie.
create table if not exists public.storefront_sessions (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  customer_id     uuid not null references public.customers(id) on delete cascade,
  token_hash      text not null,
  contact_phone   text not null,
  expires_at      timestamptz not null,
  last_seen_at    timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.storefront_sessions'::regclass
      and conname = 'storefront_sessions_datos_check'
  ) then
    alter table public.storefront_sessions
      add constraint storefront_sessions_datos_check
      check (
        token_hash ~ '^[0-9a-f]{64}$'
        and contact_phone ~ '^[0-9]{8,15}$'
      );
  end if;
end;
$$;

create unique index if not exists uq_storefront_sessions_token
  on public.storefront_sessions (token_hash);
-- Para caducar las viejas sin recorrer la tabla entera.
create index if not exists idx_storefront_sessions_vigentes
  on public.storefront_sessions (expires_at)
  where revoked_at is null;

alter table public.storefront_sessions enable row level security;


-- ── 5. El pedido recuerda de dónde vino y de quién es ───────────────────────
alter table public.orders
  add column if not exists customer_id uuid references public.customers(id) on delete set null,
  add column if not exists source text not null default 'whatsapp',
  add column if not exists address_id uuid references public.customer_addresses(id) on delete set null,
  add column if not exists fulfillment text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_origen_check'
  ) then
    alter table public.orders
      add constraint orders_origen_check
      check (
        source in ('whatsapp', 'storefront', 'marketplace', 'manual')
        and (fulfillment is null or fulfillment in ('delivery', 'pickup', 'onsite'))
      );
  end if;
end;
$$;

create index if not exists idx_orders_cliente
  on public.orders (business_id, customer_id, created_at desc);


-- ── 6. Limpieza de sesiones caducadas ───────────────────────────────────────
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
    where target.expires_at < now() - make_interval(days => v_days)
    returning 1
  )
  select count(*)::integer into v_deleted from deleted;
  return coalesce(v_deleted, 0);
end;
$$;

revoke all on function public.cleanup_storefront_sessions(integer)
  from public, anon, authenticated;

commit;


-- ── Verificación ────────────────────────────────────────────────────────────
select
  (select count(*) from pg_tables where schemaname = 'public'
    and tablename in ('customers', 'business_customers', 'customer_addresses', 'storefront_sessions')) as tablas,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relrowsecurity
      and c.relname in ('customers', 'business_customers', 'customer_addresses', 'storefront_sessions')) as con_rls,
  (select count(*) from information_schema.columns
    where table_name = 'orders' and column_name in ('customer_id', 'source', 'address_id', 'fulfillment')) as pedido_listo;

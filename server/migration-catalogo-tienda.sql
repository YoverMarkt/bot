-- ============================================================================
-- CATÁLOGO PARA LA TIENDA WEB DEL NEGOCIO
--
-- La tienda que se abre desde WhatsApp necesita tres cosas que el catálogo
-- actual no tiene:
--   1. CATEGORÍAS de verdad, con imagen y orden (hoy son etiquetas de texto).
--   2. VARIANTES con precio propio (Personal $8.50 / Mediana $12.50 / …).
--   3. EXTRAS con precio (queso extra +$1.00).
--
-- Los extras extienden `menu_modifiers` en vez de crear una tabla paralela: esa
-- tabla ya la usa el modo menú para los sabores, y separar los conceptos
-- obligaría al dueño a mantener dos pantallas que hacen casi lo mismo.
--
-- ⚠️ El precio SIGUE siendo autoridad del servidor. Estas tablas solo amplían
-- de dónde sale el precio; el total lo calcula la RPC de pedidos, nunca el
-- frontend (regla inviolable #8).
--
-- Idempotente. Correr en Supabase → SQL Editor.
-- ============================================================================

begin;

-- ── 1. Capacidad: qué negocios tienen tienda web ────────────────────────────
-- Igual que takes_orders o lodging_enabled: una decisión por negocio. Una
-- barbería seguirá solo con el menú de WhatsApp; una pizzería tendrá tienda.
alter table public.businesses
  add column if not exists storefront_enabled boolean not null default false;


-- ── 2. Categorías con imagen y orden ────────────────────────────────────────
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
  updated_at      timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.product_categories'::regclass
      and conname = 'product_categories_textos_check'
  ) then
    alter table public.product_categories
      add constraint product_categories_textos_check
      check (
        char_length(btrim(name)) between 1 and 60
        and char_length(coalesce(description, '')) <= 300
        and sort between 0 and 999
      );
  end if;
end;
$$;

create index if not exists idx_product_categories_negocio
  on public.product_categories (business_id, sort);
create unique index if not exists uq_product_categories_nombre
  on public.product_categories (business_id, lower(btrim(name)));

alter table public.product_categories enable row level security;

-- El producto puede colgar de una categoría. Se deja opcional para no romper
-- el catálogo existente, que se organiza por `tags`.
alter table public.products
  add column if not exists category_id uuid references public.product_categories(id) on delete set null;
create index if not exists idx_products_categoria
  on public.products (business_id, category_id);


-- ── 3. Variantes con precio propio ──────────────────────────────────────────
-- Un producto sin variantes sigue usando su propio `price`: nada cambia para
-- los catálogos actuales.
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
  updated_at  timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.product_variants'::regclass
      and conname = 'product_variants_datos_check'
  ) then
    alter table public.product_variants
      add constraint product_variants_datos_check
      check (
        char_length(btrim(name)) between 1 and 60
        and price >= 0 and price <= 100000
        and (price_sale is null or (price_sale >= 0 and price_sale <= 100000))
        and stock in ('disponible', 'agotado')
        and sort between 0 and 999
      );
  end if;
end;
$$;

create index if not exists idx_product_variants_producto
  on public.product_variants (business_id, product_id, sort);
create unique index if not exists uq_product_variants_nombre
  on public.product_variants (product_id, lower(btrim(name)));

alter table public.product_variants enable row level security;


-- ── 4. Extras con precio sobre menu_modifiers ───────────────────────────────
-- Hoy la tabla resuelve los sabores del modo menú (sin coste). Se le añade el
-- precio y la posibilidad de colgar de UN producto concreto en vez de toda una
-- categoría, que es lo que necesitan los extras ("queso extra +$1").
alter table public.menu_modifiers
  add column if not exists price_delta numeric(10,2) not null default 0,
  add column if not exists product_id uuid references public.products(id) on delete cascade,
  add column if not exists max_selectable integer;

-- `category_tag` deja de ser obligatorio: un extra puede ser de un producto
-- concreto. Relajar el NOT NULL no afecta a ninguna fila existente.
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
        -- Debe pertenecer a una categoría o a un producto, no al aire.
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


-- ── 5. Datos bancarios para la transferencia ────────────────────────────────
-- Los ve el cliente al pagar. No son secretos —el negocio los publica— pero se
-- guardan por negocio y solo se muestran en su propia tienda.
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
  updated_at     timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.business_bank_accounts'::regclass
      and conname = 'business_bank_accounts_datos_check'
  ) then
    alter table public.business_bank_accounts
      add constraint business_bank_accounts_datos_check
      check (
        char_length(btrim(bank_name)) between 1 and 80
        and char_length(btrim(account_number)) between 1 and 40
        and char_length(btrim(holder_name)) between 1 and 120
        and account_type in ('ahorros', 'corriente')
        and char_length(coalesce(holder_id, '')) <= 20
        and char_length(coalesce(instructions, '')) <= 300
      );
  end if;
end;
$$;

create index if not exists idx_business_bank_accounts_negocio
  on public.business_bank_accounts (business_id, active);

alter table public.business_bank_accounts enable row level security;

commit;


-- ── Verificación ────────────────────────────────────────────────────────────
select
  (select count(*) from pg_tables where schemaname = 'public'
    and tablename in ('product_categories', 'product_variants', 'business_bank_accounts')) as tablas_creadas,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relrowsecurity
      and c.relname in ('product_categories', 'product_variants', 'business_bank_accounts')) as con_rls,
  (select count(*) from information_schema.columns
    where table_name = 'menu_modifiers' and column_name in ('price_delta', 'product_id', 'max_selectable')) as extras_listos,
  (select count(*) from information_schema.columns
    where table_name = 'businesses' and column_name = 'storefront_enabled') as capacidad_lista;

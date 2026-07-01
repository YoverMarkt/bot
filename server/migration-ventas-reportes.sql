-- ============================================================
-- MIGRACIÓN: Módulo de ventas + reportes para el dueño
-- Fecha: 2026-06-30
-- Correr en Supabase → SQL Editor. Es idempotente (se puede correr varias veces).
-- NO borra ni modifica datos existentes.
-- ============================================================

-- 1) Número personal de WhatsApp del DUEÑO del negocio.
--    Solo este número puede pedir reportes por WhatsApp (validación de dueño).
alter table businesses add column if not exists owner_phone text;

-- 2) VENTAS — cabecera (una fila por venta cerrada).
create table if not exists sales (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references businesses(id) on delete cascade,   -- aislamiento multi-tenant
  contact_phone text,            -- cliente que compró (de la conversación)
  contact_name  text,
  total         numeric(10,2) not null default 0,
  status        text not null default 'completada' check (status in ('completada','anulada')),
  source        text default 'manual',   -- registrada manualmente desde el panel
  sold_at       timestamptz default now(),
  created_at    timestamptz default now()
);
create index if not exists idx_sales_biz       on sales(business_id);
create index if not exists idx_sales_biz_date   on sales(business_id, sold_at);
create index if not exists idx_sales_biz_phone  on sales(business_id, contact_phone);
alter table sales enable row level security;

-- 3) SALE_ITEMS — detalle (uno o varios ítems por venta).
--    Sin este detalle no funcionan "top productos" ni "bajo movimiento".
create table if not exists sale_items (
  id           uuid primary key default gen_random_uuid(),
  sale_id      uuid references sales(id)      on delete cascade,
  business_id  uuid references businesses(id) on delete cascade,    -- denormalizado para filtrar/RLS directo
  product_id   uuid references products(id)   on delete set null,   -- si el producto se borra, el ítem se conserva
  product_name text not null,         -- snapshot del nombre al momento de la venta
  quantity     int not null default 1,
  unit_price   numeric(10,2) not null default 0,
  line_total   numeric(10,2) not null default 0,
  created_at   timestamptz default now()
);
create index if not exists idx_sale_items_sale     on sale_items(sale_id);
create index if not exists idx_sale_items_biz_prod  on sale_items(business_id, product_id);
alter table sale_items enable row level security;

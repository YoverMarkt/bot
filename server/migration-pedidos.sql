-- ═══════════════════════════════════════════════════════════════════
-- MIGRACIÓN — Núcleo de dinero: pedidos con total calculado por CÓDIGO
-- Correr UNA vez en Supabase → SQL Editor. Aditiva y NO destructiva.
--
-- El bot emite ##PEDIDO:producto x cantidad##; el SERVIDOR resuelve los
-- productos contra la base (por business_id), calcula el total en código
-- (la IA NUNCA decide montos) y envía el resumen oficial. Estas tablas
-- guardan cada pedido con su total oficial para seguimiento operativo.
-- ═══════════════════════════════════════════════════════════════════

-- Pedido (cabecera): el total oficial vive aquí, calculado server-side.
create table if not exists orders (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid references businesses(id) on delete cascade,   -- aislamiento
  contact_phone    text not null,
  contact_name     text,
  status           text not null default 'pendiente'
                   check (status in ('pendiente','confirmado','completado','cancelado','expirado')),
  subtotal         numeric(10,2) not null default 0,
  discount         numeric(10,2) not null default 0,   -- descuentos: SOLO por código/panel, jamás decisión de la IA
  total            numeric(10,2) not null default 0,
  currency         text not null default 'USD',
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);
create index if not exists idx_orders_biz       on orders(business_id);
create index if not exists idx_orders_biz_phone on orders(business_id, contact_phone);
create index if not exists idx_orders_biz_date  on orders(business_id, created_at);
alter table orders enable row level security;

-- Ítems del pedido: precio unitario congelado al momento del pedido
-- (leído de products por el servidor; si luego cambia el catálogo, el pedido no se altera).
create table if not exists order_items (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid references orders(id)     on delete cascade,
  business_id  uuid references businesses(id) on delete cascade,
  product_id   uuid references products(id)   on delete set null,
  product_name text not null,
  quantity     int not null default 1 check (quantity > 0),
  unit_price   numeric(10,2) not null default 0,
  line_total   numeric(10,2) not null default 0,
  created_at   timestamptz default now()
);
create index if not exists idx_order_items_order on order_items(order_id);
create index if not exists idx_order_items_biz   on order_items(business_id);
alter table order_items enable row level security;

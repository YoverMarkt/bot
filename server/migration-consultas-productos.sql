-- ============================================================
-- MIGRACIÓN: Consultas de productos (para "más consultados" y "abandonados")
-- Fecha: 2026-07-01
-- Correr en Supabase → SQL Editor. Idempotente. No borra datos.
-- ============================================================

-- Un evento por cada vez que un cliente pregunta por un producto.
-- Guardar la fecha permite reportes por hoy/semana/mes o CUALQUIER rango histórico.
create table if not exists product_consultations (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid references businesses(id) on delete cascade,   -- aislamiento multi-tenant
  product_id   uuid references products(id)   on delete cascade,
  created_at   timestamptz default now()
);
create index if not exists idx_pconsult_biz_date  on product_consultations(business_id, created_at);
create index if not exists idx_pconsult_biz_prod  on product_consultations(business_id, product_id);
alter table product_consultations enable row level security;

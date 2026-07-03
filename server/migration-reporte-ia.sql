-- ============================================================
-- MIGRACIÓN: Reporte de IA — preguntas que el bot no pudo responder
-- Fecha: 2026-07-02
-- Correr en Supabase → SQL Editor. Idempotente. No borra datos.
-- ============================================================

-- Un evento por cada vez que el bot NO pudo responder (incertidumbre / handoff).
-- Guarda la pregunta del cliente → el dueño ve qué info agregar al bot.
-- Aislamiento multi-tenant: business_id + RLS (como todas las tablas).
create table if not exists ai_gaps (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references businesses(id) on delete cascade,
  contact_phone text,            -- quién preguntó (contexto, opcional)
  question      text not null,   -- la pregunta que el bot no supo responder
  reason        text,            -- 'handoff' | 'uncertain'
  created_at    timestamptz default now()
);
create index if not exists idx_ai_gaps_biz_date on ai_gaps(business_id, created_at);
alter table ai_gaps enable row level security;

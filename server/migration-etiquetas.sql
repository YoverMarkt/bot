-- ═══════════════════════════════════════════════════════════════════
-- MIGRACIÓN — Etiquetas de conversación (el dueño crea las suyas)
-- Correr UNA vez en Supabase → SQL Editor. Aditiva y NO destructiva.
-- ═══════════════════════════════════════════════════════════════════

-- Definiciones de etiquetas por negocio (nombre + color).
create table if not exists conversation_tags (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,  -- aislamiento
  name        text not null,
  color       text default '#2a78d6',
  created_at  timestamptz default now()
);
create index if not exists idx_conv_tags_biz on conversation_tags(business_id);
alter table conversation_tags enable row level security;

-- Etiquetas asignadas a cada conversación (array de IDs de conversation_tags).
alter table conversation_sessions
  add column if not exists tags jsonb default '[]'::jsonb;

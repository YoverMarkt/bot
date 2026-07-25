-- ─────────────────────────────────────────────────────────────────────────
-- Migración: modificadores de menú (sabores de pizza, salsas, extras…)
-- ─────────────────────────────────────────────────────────────────────────
-- Un "modificador" es una opción que el cliente elige ADEMÁS del producto,
-- sin cambiar el precio: p. ej. el SABOR de la pizza. El precio lo pone el
-- producto (el tamaño); el modificador solo describe qué lleva y viaja pegado
-- a la línea del pedido para que el dueño lo vea completo.
--
-- Se agrupan por `category_tag` (la categoría/tag del catálogo a la que aplican,
-- p. ej. 'pizzas'). Multi-tenant: nace con business_id + RLS + índice.
--
-- Correr en: Supabase → SQL Editor. Idempotente.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.menu_modifiers (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
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

-- Un mismo modificador no se repite dentro de su categoría del negocio
create unique index if not exists uq_menu_modifiers_business_tag_name
  on public.menu_modifiers (business_id, category_tag, lower(name));

alter table public.menu_modifiers enable row level security;

-- Igual que el resto del esquema: sin políticas permisivas; solo el service
-- role del servidor accede (salta RLS). El frontend nunca lee esta tabla directo.

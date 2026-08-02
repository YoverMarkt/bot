-- ═══════════════════════════════════════════════════════════════════════════
-- REGISTRO DE MIGRACIONES — saber qué se aplicó y qué falta
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hasta hoy las 34 migraciones del proyecto se corrían a mano en el editor SQL
-- de Supabase y NADIE llevaba la cuenta. Eso ya dolió: la del hostal y las de
-- la tienda quedaron sin correr durante días, y cuando el código espera una
-- tabla que no existe la app responde 500 sin decir por qué.
--
-- Esta tabla es el libro de cuentas. No pertenece a ningún negocio (una
-- migración es de la plataforma), así que no lleva `business_id`. RLS queda
-- ACTIVADA y sin políticas: la anon key del frontend no puede leer ni escribir
-- nada, y el servidor entra con la service key, que se salta RLS.
--
-- El `checksum` no es adorno: si alguien edita un .sql ya aplicado —lo que la
-- guía prohíbe— la huella deja de cuadrar y el comando lo grita. Sin él, un
-- archivo cambiado se vería idéntico a uno intacto.

create table if not exists schema_migrations (
  name        text primary key,
  checksum    text not null,
  applied_at  timestamptz not null default now(),
  -- 'baseline' = se dio por aplicada sin ejecutarla (las 34 que ya estaban en
  -- la base antes de existir este registro). 'runner' = la ejecutó el comando.
  source      text not null default 'runner'
);

create index if not exists idx_schema_migrations_applied
  on schema_migrations(applied_at desc);

alter table schema_migrations enable row level security;

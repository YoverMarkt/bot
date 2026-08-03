-- ============================================================================
-- LA TABLA QUE FALTABA EN PRODUCCIÓN: message_usage_migration_state
--
-- `npm run verify:drift` la encontró el 2026-08-02: `schema.sql` la crea y la
-- base real no la tiene. Y lo que hace grave el hallazgo no es la tabla —es
-- de contabilidad interna, no la usa ningún código en runtime— sino lo que
-- revela: `npm run migrate:status` decía **45 de 45 aplicadas**.
--
-- `migration-consumo-planes.sql` quedó marcada como aplicada por el baseline
-- sin haberse ejecutado entera. El registro de migraciones da por hecho que lo
-- baselineado se corrió; cuando eso no es cierto, no hay forma de saberlo salvo
-- comparando el esquema real, que es justo lo que hace `verify:drift`.
--
-- ⚠️ Por eso `verify:drift` tiene que correrse antes de cada despliegue. No
-- puede ir en el CI porque necesita las credenciales de la base real.
--
-- Idempotente. No toca datos de negocio.
-- ============================================================================

-- Marcadores internos para que las inicializaciones de una sola vez sigan
-- siendo seguras aunque su archivo se ejecute de nuevo meses después.
create table if not exists public.message_usage_migration_state (
  key          text primary key,
  completed_at timestamptz not null default now()
);

-- Nunca la lee el frontend ni el bot: es contabilidad del propio esquema.
alter table public.message_usage_migration_state enable row level security;
revoke all on table public.message_usage_migration_state
  from public, anon, authenticated;

-- ── El relleno de límites: se marca hecho, no se rehace ──────────────────────
-- Producción ya tiene las dos columnas Y sus valores (los planes micro están
-- en 50/250). Volver a rellenar no borraría nada —el original usa `coalesce`,
-- solo toca NULLs— pero marcarlo evita que una futura re-aplicación de
-- `migration-consumo-planes.sql` recorra la tabla de negocios sin motivo.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'businesses'
      and column_name = 'monthly_contact_limit'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'businesses'
      and column_name = 'monthly_outbound_message_limit'
  ) then
    insert into public.message_usage_migration_state (key)
    values ('limits_v1')
    on conflict (key) do nothing;
  else
    -- Base a medio migrar: se hace el relleno original antes de marcarlo.
    update public.businesses
    set monthly_contact_limit = coalesce(monthly_contact_limit, 50),
        monthly_outbound_message_limit =
          coalesce(monthly_outbound_message_limit, 250)
    where lower(coalesce(plan, 'basic')) in ('basic', 'micro', 'founder');

    insert into public.message_usage_migration_state (key)
    values ('limits_v1')
    on conflict (key) do nothing;
  end if;
end;
$$;

-- ── Comprobación inmediata ──────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public'
      and table_name = 'message_usage_migration_state'
  ) then
    raise exception 'La tabla message_usage_migration_state no quedó creada';
  end if;

  if not exists (
    select 1 from public.message_usage_migration_state where key = 'limits_v1'
  ) then
    raise exception 'El marcador limits_v1 no quedó registrado';
  end if;

  raise notice 'MARCADOR DE CONSUMO: tabla creada y limits_v1 registrado';
end;
$$;

-- ============================================================================
-- REGISTRO DE ERRORES DE PLATAFORMA
--
-- Motivo: en julio de 2026 el canal de WhatsApp estuvo caído cinco días y la
-- única pista del fallo vivía en los logs de Railway, que se rotan y nadie mira.
-- Esta tabla deja rastro consultable y descargable desde el panel del superadmin.
--
-- DISEÑO: agrupa por huella en vez de guardar una fila por ocurrencia. Un error
-- que se repite mil veces es UNA fila con occurrences = 1000, lo que evita
-- inflar la tabla, mantiene el egress bajo y además informa mejor ("esto lleva
-- fallando 340 veces desde el 26 de julio").
--
-- La huella se calcula en Node y llega ya hecha: aquí NO se usa digest() de
-- pgcrypto a propósito, porque su ausencia en el search_path fue justamente lo
-- que tumbó el canal de entrada.
--
-- Idempotente. Correr en Supabase → SQL Editor.
-- ============================================================================

begin;

-- ── Tabla ───────────────────────────────────────────────────────────────────
-- `business_id` admite NULL: hay errores que no pertenecen a ningún negocio
-- (arranque del servidor, webhook que no llegó a resolverse). Cuando sí hay
-- negocio, la FK en cascada garantiza que al borrarlo se lleve sus errores.
create table if not exists public.platform_errors (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references public.businesses(id) on delete cascade,
  category      text not null,
  code          text,
  message       text not null,
  context       jsonb not null default '{}'::jsonb,
  fingerprint   text not null,
  occurrences   integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.platform_errors'::regclass
      and conname = 'platform_errors_category_check'
  ) then
    alter table public.platform_errors
      add constraint platform_errors_category_check
      check (category in ('canal', 'ia', 'envio', 'servidor'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.platform_errors'::regclass
      and conname = 'platform_errors_tamanos_check'
  ) then
    -- Techos para que un error enorme no se coma la base ni el egress.
    alter table public.platform_errors
      add constraint platform_errors_tamanos_check
      check (
        char_length(message) between 1 and 2000
        and char_length(coalesce(code, '')) <= 120
        and fingerprint ~ '^[0-9a-f]{64}$'
        and occurrences >= 1
        and pg_column_size(context) <= 8192
      );
  end if;
end;
$$;

-- ── Índices ─────────────────────────────────────────────────────────────────
-- Los dos usos reales: "últimos errores de la plataforma" y "errores de este
-- negocio". No se indexa nada más hasta que haga falta.
create index if not exists idx_platform_errors_recientes
  on public.platform_errors (last_seen_at desc);
create index if not exists idx_platform_errors_negocio
  on public.platform_errors (business_id, last_seen_at desc);

-- Una huella por negocio. Se necesitan dos índices parciales porque en SQL
-- NULL nunca es igual a NULL, así que los errores sin negocio se agrupan aparte.
create unique index if not exists uq_platform_errors_negocio_huella
  on public.platform_errors (business_id, fingerprint)
  where business_id is not null;
create unique index if not exists uq_platform_errors_huella_global
  on public.platform_errors (fingerprint)
  where business_id is null;

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Sin políticas permisivas: solo el backend (service key) escribe y lee.
alter table public.platform_errors enable row level security;

-- ── Registro con agrupación atómica ─────────────────────────────────────────
create or replace function public.record_platform_error(
  p_business_id uuid,
  p_category text,
  p_code text,
  p_message text,
  p_context jsonb,
  p_fingerprint text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_message text;
  v_context jsonb;
begin
  if p_category not in ('canal', 'ia', 'envio', 'servidor') then
    raise exception using errcode = '22023', message = 'Categoria de error invalida';
  end if;
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Huella de error invalida';
  end if;

  v_message := left(coalesce(nullif(btrim(p_message), ''), 'Error sin detalle'), 2000);
  v_context := case
    when jsonb_typeof(p_context) = 'object' and pg_column_size(p_context) <= 8192
      then p_context
    else '{}'::jsonb
  end;

  -- Upsert atómico: si la huella ya existe suma una ocurrencia y refresca el
  -- detalle. Se resuelve con `on conflict` sobre los índices parciales en lugar
  -- de capturar excepciones, para no dejar nunca una transacción a medias ni
  -- siquiera cuando dos errores idénticos llegan a la vez. Hacen falta dos
  -- ramas porque en SQL NULL nunca es igual a NULL.
  if p_business_id is null then
    insert into public.platform_errors (
      business_id, category, code, message, context, fingerprint
    ) values (
      null, p_category, left(p_code, 120), v_message, v_context, p_fingerprint
    )
    on conflict (fingerprint) where business_id is null do update
    set occurrences = public.platform_errors.occurrences + 1,
        last_seen_at = now(),
        code = excluded.code,
        message = excluded.message,
        context = excluded.context
    returning id into v_id;
  else
    insert into public.platform_errors (
      business_id, category, code, message, context, fingerprint
    ) values (
      p_business_id, p_category, left(p_code, 120), v_message, v_context, p_fingerprint
    )
    on conflict (business_id, fingerprint) where business_id is not null do update
    set occurrences = public.platform_errors.occurrences + 1,
        last_seen_at = now(),
        code = excluded.code,
        message = excluded.message,
        context = excluded.context
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

-- ── Retención ───────────────────────────────────────────────────────────────
-- Mismo patrón que cleanup_webhook_events: se llama a diario desde el servidor.
create or replace function public.cleanup_platform_errors(p_days integer default 30)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
  v_days integer := greatest(coalesce(p_days, 30), 1);
begin
  with deleted as (
    delete from public.platform_errors as target
    where target.last_seen_at < now() - make_interval(days => v_days)
    returning 1
  )
  select count(*)::integer into v_deleted from deleted;
  return coalesce(v_deleted, 0);
end;
$$;

revoke all on function public.record_platform_error(uuid, text, text, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.cleanup_platform_errors(integer)
  from public, anon, authenticated;

commit;


-- ── Verificación ────────────────────────────────────────────────────────────
select
  (select count(*) from pg_tables
    where schemaname = 'public' and tablename = 'platform_errors') as tabla_creada,
  (select relrowsecurity from pg_class
    where oid = 'public.platform_errors'::regclass) as rls_activa,
  (select count(*) from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('record_platform_error', 'cleanup_platform_errors')) as funciones;

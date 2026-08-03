-- ============================================================================
-- EL ENLACE DE LA MINI APP DEJA DE CADUCAR, Y SE PROTEGE POR TELÉFONO
--
-- Dos cambios que van juntos porque uno sin el otro deja un agujero.
--
-- ── 1. Sin caducidad ────────────────────────────────────────────────────────
-- `expires_at` pasa a admitir nulo, y nulo significa "no caduca nunca". Se
-- conserva la columna en vez de borrarla porque las sesiones que se creen para
-- otras cosas —si algún día hace falta una temporal— siguen pudiendo usarla.
--
-- Ojo con `cleanup_storefront_sessions`: borraba por `expires_at < now()`, así
-- que con nulo dejaría de borrar nada (comparar con null da null, no true) y
-- la tabla crecería para siempre sin avisar. Se reescribe para que borre solo
-- las que SÍ tienen caducidad, y las permanentes se quedan.
--
-- ── 2. Gana quien demuestre el número, no quien abra primero ────────────────
-- Hasta ahora la sesión se ataba al PRIMER dispositivo que la abriera:
--
--     if (!session.device_hash) return { ok: true, claims: true }
--
-- Eso tiene un fallo que se ve en cuanto alguien reenvía el enlace ANTES de
-- abrirlo: el amigo lo abre, se queda la sesión, y el cliente legítimo recibe
-- «ya lo está usando otra persona» sobre su propio enlace.
--
-- Ahora el dispositivo se ata solo tras confirmar el número de WhatsApp al que
-- se emitió. El que reenvía no puede entrar —su número no coincide— y ve la
-- pantalla que le dice que le escriba al local para pedir el suyo. Y el
-- cliente que cambia de teléfono vuelve a entrar confirmando su número, sin
-- tener que pedir un enlace nuevo.
--
-- `verified_at` deja constancia de cuándo se confirmó. No es decorativo: es lo
-- que permite distinguir una sesión atada por el camino nuevo de una atada por
-- el viejo, y auditar el día que haga falta.
--
-- Idempotente. No toca las sesiones existentes: las que ya estén atadas siguen
-- funcionando en su dispositivo.
-- ============================================================================

alter table public.storefront_sessions
  alter column expires_at drop not null;

alter table public.storefront_sessions
  add column if not exists verified_at timestamptz;

comment on column public.storefront_sessions.expires_at is
  'Nulo = el enlace no caduca. Es el caso normal desde el 2026-08-02.';
comment on column public.storefront_sessions.verified_at is
  'Cuándo se confirmó el número de WhatsApp desde el dispositivo que la usa.';

-- ── La limpieza respeta las permanentes ─────────────────────────────────────
create or replace function public.cleanup_storefront_sessions(
  p_days integer default 7
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_days integer := greatest(coalesce(p_days, 7), 0);
  v_deleted integer;
begin
  with deleted as (
    delete from public.storefront_sessions as target
    -- `expires_at is not null` es la línea que importa: sin ella, las sesiones
    -- permanentes entrarían en una comparación con null —que da null, no
    -- false— y el borrado dejaría de funcionar del todo.
    where target.expires_at is not null
      and target.expires_at < now() - make_interval(days => v_days)
    returning 1
  )
  select count(*)::integer into v_deleted from deleted;
  return coalesce(v_deleted, 0);
end;
$$;

revoke all on function public.cleanup_storefront_sessions(integer)
  from public, anon, authenticated;
grant execute on function public.cleanup_storefront_sessions(integer) to service_role;

-- ── Comprobación inmediata ──────────────────────────────────────────────────
do $comprobacion$
declare
  v_b uuid; v_c uuid; v_permanente uuid; v_temporal uuid; v_borradas integer;
begin
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders, chat_mode
  ) values (
    'permanente-tmp', 'Permanente', 'tienda', 'ycloud',
    '+593900888001', '+593900888001', true, 'miniapp'
  ) returning id into v_b;
  insert into public.customers (phone) values ('593900888002') returning id into v_c;

  -- Una sesión SIN caducidad: es el caso normal a partir de ahora.
  insert into public.storefront_sessions (
    business_id, customer_id, token_hash, contact_phone, expires_at
  ) values (
    v_b, v_c, repeat('a', 64), '593900888002', null
  ) returning id into v_permanente;

  -- Y una vieja, ya vencida hace mucho.
  insert into public.storefront_sessions (
    business_id, customer_id, token_hash, contact_phone, expires_at
  ) values (
    v_b, v_c, repeat('b', 64), '593900888002', now() - interval '30 days'
  ) returning id into v_temporal;

  v_borradas := public.cleanup_storefront_sessions(7);

  if not exists (select 1 from public.storefront_sessions where id = v_permanente) then
    raise exception 'La limpieza borró una sesión permanente';
  end if;
  if exists (select 1 from public.storefront_sessions where id = v_temporal) then
    raise exception 'La limpieza NO borró una sesión vencida hace 30 días';
  end if;

  delete from businesses where id = v_b;
  delete from public.customers where id = v_c;
  raise notice 'ENLACE PERMANENTE: las sin caducidad se quedan, las vencidas se van';
end;
$comprobacion$;

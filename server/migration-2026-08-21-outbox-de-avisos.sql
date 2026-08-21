-- ═══════════════════════════════════════════════════════════════════════════
-- EL AVISO QUE FALLA SE REINTENTA
--
-- Hoy el aviso al cliente se RECLAMA antes de enviarse
-- (`routes/orders.routes.ts`, `claimOrderNotification` → `notificar…`). El
-- reclamo es atómico y existe por una buena razón: sin él, dos toques en el
-- botón mandan —y cobran— dos mensajes.
--
-- ⚠️ Pero tiene una consecuencia que no se ve: si el envío falla —fuera de la
-- ventana de 24 h de Meta, sin saldo, canal caído—, el reclamo YA se consumió
-- y ese aviso no se manda nunca más. El cliente se queda sin saber que su
-- pedido está listo, y en el registro solo queda una línea de error.
--
-- El outbox separa las dos cosas: el reclamo sigue garantizando UN aviso por
-- hito, y el outbox garantiza que ese aviso se INTENTE hasta que salga.
--
--   reclamar (atómico, una vez)  →  encolar  →  enviar  →  completar
--                                      ↑            ↓ falla
--                                      └──── reintento con espera ────┘
--
-- ⚠️ El envío inmediato SE CONSERVA. Si el worker fuera el único camino, el
-- cliente recibiría su aviso segundos tarde siempre, y un worker caído dejaría
-- a todos los negocios sin avisar. Se envía ya y solo se reintenta lo que
-- falló, que es lo que hoy se pierde.
--
-- ⚠️ Mismo patrón de leases que `webhook_inbound_events`: código probado en
-- producción desde hace meses, no inventado esta noche.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.outbox_events (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  event_type     text not null,
  aggregate_type text not null default 'order',
  aggregate_id   uuid not null,
  payload        jsonb not null,
  status         text not null default 'pending'
                 check (status in ('pending','processing','completed','dead')),
  attempts       integer not null default 0,
  max_attempts   integer not null default 6,
  available_at   timestamptz not null default now(),
  lease_token    uuid,
  lease_owner    text,
  leased_until   timestamptz,
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  completed_at   timestamptz,
  dead_at        timestamptz,

  constraint outbox_events_type_check check (
    event_type ~ '^[a-z][a-z_]{2,49}$' and aggregate_type ~ '^[a-z_]{3,30}$'
  ),
  constraint outbox_events_attempts_check check (
    attempts between 0 and max_attempts and max_attempts between 1 and 50
  ),
  constraint outbox_events_payload_check check (
    jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 65536
  ),
  -- El lease existe entero o no existe: un token sin fecha deja un evento
  -- tomado para siempre por nadie.
  constraint outbox_events_lease_check check (
    (status = 'processing' and lease_token is not null and leased_until is not null
     and nullif(btrim(lease_owner), '') is not null and char_length(lease_owner) <= 128)
    or
    (status <> 'processing' and lease_token is null and leased_until is null
     and lease_owner is null)
  )
);

alter table public.outbox_events enable row level security;

revoke all on table public.outbox_events
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.outbox_events to service_role;

-- Para el worker: lo pendiente que ya toca, en orden de llegada.
create index if not exists idx_outbox_pendientes
  on public.outbox_events (available_at, created_at)
  where status = 'pending';

-- Para recuperar leases vencidos de un worker que murió a media faena.
create index if not exists idx_outbox_vencidos
  on public.outbox_events (leased_until)
  where status = 'processing';

-- Para la reconciliación y el panel: qué le pasó a los avisos de un negocio.
create index if not exists idx_outbox_negocio
  on public.outbox_events (business_id, created_at desc);

-- ⚠️ UN evento por hito de un pedido. El reclamo ya lo garantiza aguas arriba,
-- pero esto lo cierra en la base: si algún camino futuro encola sin reclamar,
-- el índice lo impide en vez de mandar dos mensajes de pago.
create unique index if not exists uq_outbox_hito
  on public.outbox_events (aggregate_id, event_type, (payload ->> 'status'))
  where aggregate_type = 'order';


-- ── Encolar ────────────────────────────────────────────────────────────────
--
-- Devuelve el id del evento, o NULL si ya estaba encolado. El `on conflict do
-- nothing` es la red del índice de arriba: encolar dos veces no crea dos.
create or replace function public.enqueue_outbox_event(
  p_business_id    uuid,
  p_event_type     text,
  p_aggregate_id   uuid,
  p_payload        jsonb,
  p_aggregate_type text default 'order',
  -- ⚠️ Nace con espera A PROPÓSITO. El envío inmediato corre justo después de
  -- encolar; sin esta ventana, el worker podría tomarlo mientras ese envío
  -- está en vuelo y mandar —y cobrar— el mismo aviso dos veces. Un minuto es
  -- de sobra para un envío que normalmente tarda menos de un segundo.
  p_espera_s       integer default 60
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.outbox_events (
    business_id, event_type, aggregate_type, aggregate_id, payload,
    status, attempts, max_attempts, available_at
  ) values (
    p_business_id, p_event_type, coalesce(p_aggregate_type, 'order'),
    p_aggregate_id, coalesce(p_payload, '{}'::jsonb),
    'pending', 0, 6,
    now() + make_interval(secs => greatest(coalesce(p_espera_s, 60), 0))
  )
  on conflict do nothing
  returning id into v_id;

  return v_id;
end;
$$;


-- ── Tomar trabajo ──────────────────────────────────────────────────────────
--
-- `for update skip locked`: dos workers no se pelean por el mismo evento y
-- ninguno espera al otro. Recupera además los leases vencidos — un worker que
-- murió a media faena no puede dejar un aviso tomado para siempre.
create or replace function public.lease_outbox_events(
  p_owner   text,
  p_limite  integer default 10,
  p_lease_s integer default 60
)
returns setof public.outbox_events
language plpgsql
set search_path = public, pg_temp
as $$
begin
  return query
  with candidatos as (
    select e.id
    from public.outbox_events e
    where (
      (e.status = 'pending' and e.available_at <= now())
      or (e.status = 'processing' and e.leased_until < now())
    )
      and e.attempts < e.max_attempts
    order by e.available_at, e.created_at
    limit greatest(coalesce(p_limite, 10), 1)
    for update skip locked
  )
  update public.outbox_events e
     set status       = 'processing',
         lease_token  = gen_random_uuid(),
         lease_owner  = left(coalesce(nullif(btrim(p_owner), ''), 'worker'), 128),
         leased_until = now() + make_interval(secs => greatest(coalesce(p_lease_s, 60), 5)),
         attempts     = e.attempts + 1,
         updated_at   = now()
    from candidatos c
   where e.id = c.id
  returning e.*;
end;
$$;


-- ── Terminar ───────────────────────────────────────────────────────────────
create or replace function public.complete_outbox_event(p_id uuid, p_token uuid)
returns boolean
language sql
set search_path = public, pg_temp
as $$
  with hecho as (
    update public.outbox_events
       set status = 'completed', completed_at = now(), updated_at = now(),
           lease_token = null, lease_owner = null, leased_until = null,
           last_error = null
     where id = p_id
       and (
         -- El worker: completa lo que tomó, y solo con su token.
         (p_token is not null and lease_token = p_token and status = 'processing')
         -- El envío inmediato: no llegó a tomarlo, lo hizo él. Sin esto
         -- tendría que fingir un lease solo para cerrar su propio trabajo.
         or (p_token is null and status = 'pending')
       )
    returning id
  )
  select exists (select 1 from hecho);
$$;

-- Fallar: vuelve a la cola con espera creciente, o muere si se agotó.
--
-- ⚠️ La espera crece con los intentos. Reintentar cada segundo contra un canal
-- caído no lo arregla y sí gasta: 1 min, 2, 4, 8… hasta una hora.
create or replace function public.fail_outbox_event(
  p_id uuid, p_token uuid, p_error text
)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_fila public.outbox_events%rowtype;
begin
  select * into v_fila from public.outbox_events
   where id = p_id and lease_token = p_token and status = 'processing';
  if not found then return 'sin_lease'; end if;

  if v_fila.attempts >= v_fila.max_attempts then
    update public.outbox_events
       set status = 'dead', dead_at = now(), updated_at = now(),
           lease_token = null, lease_owner = null, leased_until = null,
           last_error = left(coalesce(p_error, 'sin detalle'), 500)
     where id = p_id;
    return 'muerto';
  end if;

  update public.outbox_events
     set status = 'pending', updated_at = now(),
         lease_token = null, lease_owner = null, leased_until = null,
         last_error = left(coalesce(p_error, 'sin detalle'), 500),
         available_at = now() + make_interval(
           secs => least(3600, 60 * power(2, greatest(v_fila.attempts - 1, 0))::int)
         )
   where id = p_id;
  return 'reintentar';
end;
$$;

do $$
declare v_fn text;
begin
  foreach v_fn in array array[
    'enqueue_outbox_event(uuid, text, uuid, jsonb, text, integer)',
    'lease_outbox_events(text, integer, integer)',
    'complete_outbox_event(uuid, uuid)',
    'fail_outbox_event(uuid, uuid, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', v_fn);
    execute format('grant execute on function public.%s to service_role', v_fn);
  end loop;
end;
$$;

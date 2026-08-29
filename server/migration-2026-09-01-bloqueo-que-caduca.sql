-- ════════════════════════════════════════════════════════════════════════
-- EL BLOQUEO AHORA CADUCA SOLO
-- ════════════════════════════════════════════════════════════════════════
--
-- Hasta hoy `blocked_at` era para siempre: lo ponía el sistema o el dueño, y
-- solo el dueño lo levantaba. Por eso el aviso al cliente bloqueado NUNCA
-- prometía un plazo — prometer una espera que nadie va a cumplir es cómo nació
-- el fallo del número del 2026-08-23.
--
-- El dueño lo pidió temporal el 2026-08-31: quien deja pedidos sin pagar o
-- manda comprobantes que no lo son se queda fuera de ESE local un rato, y
-- vuelve solo. Con plazo real, el mensaje ya puede decirlo.
--
-- ⚠️ `blocked_at` NO se retira ni cambia de significado. Sigue siendo «desde
-- cuándo está bloqueado», y es lo que el dueño pone a mano cuando quiere un
-- bloqueo definitivo. Lo que se añade es HASTA cuándo:
--
--   · `blocked_until` NULO + `blocked_at` puesto  → bloqueo permanente (el del
--     dueño, el de siempre). No cambia nada para quien ya lo tenía.
--   · `blocked_until` con fecha                   → bloqueo temporal: caduca
--     solo, sin que nadie lo levante.
--
-- Distinguirlos importa: si el temporal reutilizara `blocked_at` a secas, al
-- caducar habría que borrarlo y se perdería el historial de que ese cliente ya
-- estuvo bloqueado una vez.

-- ── 1. Hasta cuándo ────────────────────────────────────────────────────────
alter table public.business_customers
  add column if not exists blocked_until timestamptz;

comment on column public.business_customers.blocked_until is
  'Fin de un bloqueo TEMPORAL. Nulo con blocked_at puesto = bloqueo permanente del dueño. Al pasar la fecha el cliente vuelve solo, sin que nadie lo levante.';

-- El índice de bloqueados mira ahora las dos formas.
create index if not exists business_customers_blocked_until_idx
  on public.business_customers (business_id, blocked_until)
  where blocked_until is not null;

-- ── 2. Cuánto dura, por local ──────────────────────────────────────────────
--
-- ⚠️ Configurable y no fijo: los 2 minutos que el dueño quería para probar no
-- frenan a nadie de verdad, y 24 h castigan a quien mandó una foto borrosa.
-- 30 es el punto donde el que abusa pierde el impulso y el cliente honesto
-- vuelve a cenar esa misma noche.
alter table public.businesses
  add column if not exists block_minutes integer not null default 30;

alter table public.businesses
  drop constraint if exists businesses_block_minutes_check;
alter table public.businesses
  add constraint businesses_block_minutes_check
  check (block_minutes between 1 and 10080);

comment on column public.businesses.block_minutes is
  'Cuánto dura un bloqueo temporal en este local, en minutos (1 min a 7 días). Lo ajusta el dueño en Ajustes.';

-- ── 3. Quién está bloqueado AHORA ──────────────────────────────────────────
--
-- ⚠️ Se recrea la función que ya usaban el disparador y la ruta, en vez de
-- añadir otra: dos funciones que responden a la misma pregunta acaban
-- contestando distinto, y esta decide si un cliente puede comprar.
create or replace function public.storefront_customer_blocked(
  p_business_id uuid,
  p_customer_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.business_customers
    where business_id = p_business_id
      and customer_id = p_customer_id
      and (
        -- Permanente: el del dueño. Se reconoce porque no tiene fin.
        (blocked_at is not null and blocked_until is null)
        -- Temporal: solo mientras no haya pasado su hora.
        or (blocked_until is not null and blocked_until > now())
      )
  );
$$;

revoke all on function public.storefront_customer_blocked(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.storefront_customer_blocked(uuid, uuid)
  to service_role;

-- ── 4. Bloquear un rato, y decir hasta cuándo ──────────────────────────────
--
-- Devuelve `{blocked_until, minutes}` para que el aviso pueda prometer el
-- plazo — ahora sí, porque el plazo se cumple solo.
--
-- ⚠️ Un bloqueo temporal NO pisa uno permanente. Si el dueño ya lo echó a
-- mano, un rechazo automático no puede convertir su decisión en 30 minutos.
create or replace function public.block_customer_temporarily(
  p_business_id uuid,
  p_customer_id uuid,
  p_motivo text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_minutos integer;
  v_hasta   timestamptz;
  v_permanente boolean;
begin
  select coalesce(block_minutes, 30) into v_minutos
  from public.businesses where id = p_business_id;

  if v_minutos is null then
    return jsonb_build_object('blocked_until', null, 'minutes', null);
  end if;

  select (blocked_at is not null and blocked_until is null) into v_permanente
  from public.business_customers
  where business_id = p_business_id and customer_id = p_customer_id;

  if coalesce(v_permanente, false) then
    return jsonb_build_object('blocked_until', null, 'minutes', null, 'permanente', true);
  end if;

  v_hasta := now() + make_interval(mins => v_minutos);

  update public.business_customers
  set blocked_at = coalesce(blocked_at, now()),
      blocked_until = v_hasta,
      -- Se vuelve a poder avisar: es un bloqueo NUEVO, y el cliente tiene que
      -- enterarse de este aunque ya se le explicara uno anterior.
      blocked_notified_at = null,
      notes = case
        when p_motivo is null then notes
        else trim(both from coalesce(notes, '') || ' · ' || p_motivo)
      end,
      updated_at = now()
  where business_id = p_business_id and customer_id = p_customer_id;

  if not found then
    return jsonb_build_object('blocked_until', null, 'minutes', null);
  end if;

  return jsonb_build_object(
    'blocked_until', v_hasta,
    'minutes', v_minutos
  );
end;
$$;

revoke all on function public.block_customer_temporarily(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.block_customer_temporarily(uuid, uuid, text)
  to service_role;

-- ── 5. Dos pedidos sin pagar, no tres ──────────────────────────────────────
--
-- Decisión del dueño el 2026-08-31, después de ver que un mismo teléfono dejó
-- SEIS pedidos sin pagar en un día. Y el bloqueo pasa a ser TEMPORAL: al
-- segundo abandono se cierra el local un rato, no para siempre.
create or replace function public.register_unpaid_expiry(
  p_business_id uuid,
  p_order_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limite  constant integer := 2;
  v_cliente uuid;
  v_faltas  integer;
  v_bloqueo jsonb;
begin
  select customer_id into v_cliente
  from public.orders
  where id = p_order_id and business_id = p_business_id;

  if v_cliente is null then
    return jsonb_build_object('strikes', 0, 'blocked', false, 'limit', v_limite);
  end if;

  update public.business_customers
  set unpaid_expiries = unpaid_expiries + 1,
      updated_at = now()
  where business_id = p_business_id and customer_id = v_cliente
  returning unpaid_expiries into v_faltas;

  if not found then
    return jsonb_build_object('strikes', 0, 'blocked', false, 'limit', v_limite);
  end if;

  if v_faltas < v_limite then
    return jsonb_build_object('strikes', v_faltas, 'blocked', false, 'limit', v_limite);
  end if;

  v_bloqueo := public.block_customer_temporarily(
    p_business_id, v_cliente, 'pedidos sin pagar'
  );

  return jsonb_build_object(
    'strikes', v_faltas,
    'blocked', true,
    'limit', v_limite,
    'blocked_until', v_bloqueo -> 'blocked_until',
    'minutes', v_bloqueo -> 'minutes'
  );
end;
$$;

revoke all on function public.register_unpaid_expiry(uuid, uuid) from public, anon, authenticated;
grant execute on function public.register_unpaid_expiry(uuid, uuid) to service_role;

-- ── 6. Los comprobantes que NO son comprobantes también cuentan ────────────
--
-- La compuerta ya rechazaba la foto de un perro y le pedía al cliente la
-- captura buena. Lo que faltaba es que insistir tuviera consecuencia: quien
-- manda dos seguidas está probando, no equivocándose.
--
-- ⚠️ Se cuenta por CLIENTE y NEGOCIO, igual que los pedidos sin pagar, y por
-- el mismo motivo: el local sale del PEDIDO que espera pago, nunca del número
-- por el que llegó la foto.
alter table public.business_customers
  add column if not exists rejected_receipts integer not null default 0;

comment on column public.business_customers.rejected_receipts is
  'Imágenes seguidas que no eran un comprobante. Se pone a cero en cuanto llega uno bueno: cuenta la INSISTENCIA, no el historial.';

-- ⚠️ Devuelve `{strikes, blocked, limit, minutes}` como su gemela de los
-- pedidos, para que el aviso pueda decir la verdad en los dos casos.
create or replace function public.register_rejected_receipt(
  p_business_id uuid,
  p_customer_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limite  constant integer := 2;
  v_faltas  integer;
  v_bloqueo jsonb;
begin
  update public.business_customers
  set rejected_receipts = rejected_receipts + 1,
      updated_at = now()
  where business_id = p_business_id and customer_id = p_customer_id
  returning rejected_receipts into v_faltas;

  if not found then
    return jsonb_build_object('strikes', 0, 'blocked', false, 'limit', v_limite);
  end if;

  if v_faltas < v_limite then
    return jsonb_build_object('strikes', v_faltas, 'blocked', false, 'limit', v_limite);
  end if;

  v_bloqueo := public.block_customer_temporarily(
    p_business_id, p_customer_id, 'comprobantes que no lo eran'
  );

  return jsonb_build_object(
    'strikes', v_faltas,
    'blocked', true,
    'limit', v_limite,
    'blocked_until', v_bloqueo -> 'blocked_until',
    'minutes', v_bloqueo -> 'minutes'
  );
end;
$$;

revoke all on function public.register_rejected_receipt(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.register_rejected_receipt(uuid, uuid) to service_role;

-- ⚠️ Y el contador se PONE A CERO cuando llega uno bueno.
--
-- Cuenta la insistencia, no el historial: quien mandó una foto borrosa, luego
-- la buena, y dentro de tres semanas otra borrosa, no es el que está probando
-- a ver si cuela algo. Sin esto, un cliente fiel acabaría bloqueado por dos
-- despistes separados por meses.
create or replace function public.clear_rejected_receipts(
  p_business_id uuid,
  p_customer_id uuid
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.business_customers
  set rejected_receipts = 0, updated_at = now()
  where business_id = p_business_id
    and customer_id = p_customer_id
    and rejected_receipts > 0;
$$;

revoke all on function public.clear_rejected_receipts(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.clear_rejected_receipts(uuid, uuid) to service_role;

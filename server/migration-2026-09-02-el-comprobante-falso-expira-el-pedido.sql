-- ═══════════════════════════════════════════════════════════════════════════
-- MANDAR COMPROBANTES QUE NO SON DEJA EL PEDIDO EXPIRADO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Lo encontró el dueño probando la mañana del 2026-09-02, y describió las tres
-- consecuencias encadenadas con precisión:
--
--   «Envié dos comprobantes falsos, me bloqueó 30 minutos —bien—. Luego puse
--    "hola" y me salió que tenía un pedido en proceso. Ese mensaje sale porque
--    en el panel del dueño ese pedido todavía está. Una vez que el cliente
--    manda el comprobante mal por hacer una broma, ese pedido debería quedar
--    expirado, para que ya no se cuente y para que al escribir le salgan las
--    categorías.»
--
-- ── LA CAUSA ───────────────────────────────────────────────────────────────
--
-- `register_rejected_receipt` bloqueaba al cliente y **no tocaba el pedido**.
-- El pedido se quedaba en `esperando_pago`, así que:
--
--  1. `orders_release_shopping_lock` no soltaba nada —solo suelta al SALIR de
--     `esperando_pago`—, el candado seguía puesto y cualquier mensaje recibía
--     «Tienes un pedido en proceso en Monster Pizza. Termínalo…».
--  2. El dueño veía en su panel una comanda que nadie iba a pagar.
--  3. Y el pedido seguía contando contra el tope de pedidos abiertos.
--
-- Un solo cambio los arregla los tres: al bloquear, el pedido muere.
--
-- ── POR QUÉ `expirado` Y NO OTRO ESTADO ────────────────────────────────────
--
-- El dueño preguntó cuál recomendaba. `expirado` es el correcto y ya existe:
--
--  · `rechazado` lo pone el DUEÑO cuando mira un comprobante y no le cuadra.
--    Aquí el dueño no ha hecho nada, y atribuirle una decisión que no tomó
--    ensucia su historial.
--  · `cancelado` es lo que pasa cuando alguien —cliente o local— da marcha
--    atrás a propósito. Tampoco es esto.
--  · `expirado` significa exactamente lo que pasó: **murió sin pagarse**. Es
--    el mismo que pone `expire_unpaid_orders` a los 15 minutos, el panel ya
--    lo trata como cerrado, la mini app ya sabe pintarlo y
--    `orders_release_shopping_lock` ya lo reconoce como salida.
--
-- ⚠️ **NO se cuenta como impago** (`register_unpaid_expiry` NO se llama). Ya
-- se le bloqueó 30 minutos por los comprobantes; sumarle además una falta de
-- «pedido sin pagar» sería cobrarle dos castigos por el mismo acto, y el
-- segundo lo acercaría al bloqueo largo sin haber hecho nada más. El dueño lo
-- dijo con estas palabras: «que no los cuente… que cada pedido funcione como
-- único».
--
-- ⚠️ **Solo los suyos y solo en ESE local.** El bloqueo por comprobantes es
-- del local, no de la plataforma: sus pedidos en otras pizzerías no se tocan.
--
-- ⚠️ **Solo `esperando_pago` y sin comprobante bueno adjunto.** Si ya había
-- mandado uno válido para otro pedido, ese está en `pago_en_revision` y no se
-- toca: lo mira el dueño.
-- ═══════════════════════════════════════════════════════════════════════════

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
  v_muertos integer := 0;
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

  -- ── El pedido muere con el bloqueo ──────────────────────────────────────
  --
  -- ⚠️ Va DESPUÉS de bloquear y en la misma transacción: si el bloqueo falla,
  -- el pedido no se toca. Lo contrario —matar el pedido y no bloquear— dejaría
  -- al cliente sin comanda y con vía libre para abrir otra.
  --
  -- `orders_release_shopping_lock` se encarga del resto: al salir de
  -- `esperando_pago` suelta el candado y el local, así que el siguiente
  -- mensaje de esta persona cae en el menú y ve las categorías. Esa es la
  -- tercera cosa que pedía el dueño, y sale sola de esta.
  with muertos as (
    update public.orders
       set status = 'expirado',
           updated_at = now()
     where business_id = p_business_id
       and customer_id = p_customer_id
       and status = 'esperando_pago'
       and coalesce(source, '') = 'storefront'
       -- Sin comprobante bueno adjunto: si lo hubiera, estaría en
       -- `pago_en_revision` y le tocaría mirarlo al dueño.
       and payment_proof_url is null
       and payment_confirmed_at is null
    returning 1
  )
  select count(*)::integer into v_muertos from muertos;

  return jsonb_build_object(
    'strikes', v_faltas,
    'blocked', true,
    'limit', v_limite,
    'blocked_until', v_bloqueo -> 'blocked_until',
    'minutes', v_bloqueo -> 'minutes',
    -- Cuántas comandas se cerraron. Sirve para decírselo al cliente sin
    -- volver a consultar la base donde se responde.
    'expired', v_muertos
  );
end;
$$;

comment on function public.register_rejected_receipt(uuid, uuid) is
  'Cuenta comprobantes que no lo eran. Al segundo bloquea el local un rato Y '
  'deja EXPIRADOS sus pedidos sin pagar ahí: la comanda no puede sobrevivir a '
  'quien ya no puede pagarla. No cuenta como impago — sería castigar dos veces.';

revoke all on function public.register_rejected_receipt(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.register_rejected_receipt(uuid, uuid)
  to service_role;

-- ── Comprobación inmediata ─────────────────────────────────────────────────
do $comprobacion$
declare
  v_local   uuid;
  v_otro    uuid;
  v_cliente uuid;
  v_p1      uuid;
  v_p2      uuid;
  v_ajeno   uuid;
  v_r       jsonb;
  v_estado  text;
  v_locked  boolean;
  v_impagos integer;
begin
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders, chat_mode
  ) values
    ('falso-uno-tmp', 'Pizza', 'pizzeria', 'ycloud', '+593900777301', '+593900777301', true, 'miniapp'),
    ('falso-dos-tmp', 'Otra', 'pizzeria', 'ycloud', '+593900777302', '+593900777302', true, 'miniapp');
  select id into v_local from businesses where slug = 'falso-uno-tmp';
  select id into v_otro  from businesses where slug = 'falso-dos-tmp';

  insert into public.customers (phone) values ('593900777400') returning id into v_cliente;
  insert into public.business_customers (business_id, customer_id) values (v_local, v_cliente);
  insert into public.business_customers (business_id, customer_id) values (v_otro, v_cliente);
  insert into public.marketplace_conversations (
    customer_id, selected_business_id, shopping_locked, current_state
  ) values (v_cliente, v_local, true, 'esperando_comprobante');

  -- ── ESCENARIO REAL: UN pedido esperando su comprobante ──────────────────
  --
  -- ⚠️ Se inserta como MOSTRADOR y se convierte en pedido de TIENDA con un
  -- update: `orders_limit_open_per_customer` es BEFORE INSERT y solo mira
  -- `source = 'storefront'`. Se cambia solo `source`, nunca el estado, para no
  -- disparar `orders_release_shopping_lock` (es `after update of status`).
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_local, v_cliente, '593900777400', 'manual', 'esperando_pago', 9, 9)
  returning id into v_p1;
  update public.orders set source = 'storefront' where id = v_p1;

  -- 1. La PRIMERA imagen mala avisa y no mata nada.
  v_r := public.register_rejected_receipt(v_local, v_cliente);
  if (v_r->>'blocked')::boolean then
    raise exception 'la PRIMERA imagen mala no puede bloquear: %', v_r;
  end if;
  select status into v_estado from public.orders where id = v_p1;
  if v_estado <> 'esperando_pago' then
    raise exception 'la primera falta mató el pedido: %', v_estado;
  end if;

  -- 2. La SEGUNDA bloquea Y deja el pedido EXPIRADO.
  v_r := public.register_rejected_receipt(v_local, v_cliente);
  if not (v_r->>'blocked')::boolean or (v_r->>'expired')::integer <> 1 then
    raise exception 'la segunda debía bloquear y expirar 1: %', v_r;
  end if;
  select status into v_estado from public.orders where id = v_p1;
  if v_estado <> 'expirado' then
    raise exception 'el pedido sin pagar debía quedar EXPIRADO, quedó %', v_estado;
  end if;

  -- 3. Y EL CANDADO SE SUELTA SOLO. Es lo que hace que el siguiente mensaje
  -- del cliente vea las categorías en vez de «tienes un pedido en proceso»,
  -- que es lo que el dueño vivió el 2026-09-02.
  select shopping_locked into v_locked
    from public.marketplace_conversations where customer_id = v_cliente;
  if v_locked then
    raise exception 'expirado el pedido, el candado siguió puesto';
  end if;

  -- 4. Y NO se cuenta además como impago: ya se le bloqueó por los
  -- comprobantes, y sumarle una falta de «pedido sin pagar» sería cobrarle dos
  -- castigos por el mismo acto.
  select unpaid_expiries into v_impagos
    from public.business_customers
   where business_id = v_local and customer_id = v_cliente;
  if coalesce(v_impagos, 0) <> 0 then
    raise exception 'el comprobante falso contó además como impago: %', v_impagos;
  end if;

  -- ── AISLAMIENTO: lo que NO es suyo no se toca ───────────────────────────
  --
  -- Se prueba aparte porque en producción no pueden coexistir —#296 deja UN
  -- pedido sin pagar a la vez—, pero la función tiene que filtrar igual: un
  -- histórico o un pedido de mostrador podrían estar ahí.
  update public.business_customers
     set rejected_receipts = 0, blocked_at = null, blocked_until = null
   where business_id = v_local and customer_id = v_cliente;

  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_otro, v_cliente, '593900777400', 'manual', 'esperando_pago', 5, 5)
  returning id into v_ajeno;
  insert into public.orders (
    business_id, customer_id, contact_phone, source, status, subtotal, total, payment_proof_url
  ) values (v_local, v_cliente, '593900777400', 'manual', 'esperando_pago', 7, 7, 'https://x/y.jpg')
  returning id into v_p2;
  update public.orders set source = 'storefront' where id in (v_ajeno, v_p2);

  perform public.register_rejected_receipt(v_local, v_cliente);
  v_r := public.register_rejected_receipt(v_local, v_cliente);
  -- Ninguno de los dos entra: uno es de otro local, el otro ya tiene su foto.
  if (v_r->>'expired')::integer <> 0 then
    raise exception 'expiró pedidos que no debía: %', v_r;
  end if;

  select status into v_estado from public.orders where id = v_ajeno;
  if v_estado <> 'esperando_pago' then
    raise exception 'se expiró un pedido de OTRO local: %', v_estado;
  end if;
  select status into v_estado from public.orders where id = v_p2;
  if v_estado <> 'esperando_pago' then
    raise exception 'se expiró un pedido que YA tenía comprobante: %', v_estado;
  end if;

  delete from businesses where id in (v_local, v_otro);
  delete from public.customers where id = v_cliente;
  raise notice 'COMPROBANTE FALSO: bloquea, expira su pedido, suelta el candado y no cuenta dos veces';
end;
$comprobacion$;

-- ═══════════════════════════════════════════════════════════════════════════
-- EL PEDIDO AVISA A LA CONVERSACIÓN, Y ABANDONAR A PROPÓSITO NO SE CASTIGA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Lo encontró el dueño probando el 2026-09-04: hizo el pedido por la mini app,
-- escribió «hola» en vez de subir el comprobante, y el bot le contestó
-- «Tienes un pedido en proceso. **Termínalo**, o empieza de nuevo». Pulsó
-- «Seguir mi pedido» y recibió «Perfecto, sigues en Monster Pizza. **Termina
-- tu pedido cuando quieras**» con el enlace de la carta.
--
--   «No debería pasar eso, sino decirme que ya tengo un pedido pero que tengo
--    que subir el comprobante. Y que si no quiero seguir, escriba MENÚ, para
--    no caer en un pedido abandonado y que me multen después.»
--
-- ── CAUSA 1: la mini app no avisaba a nadie ────────────────────────────────
--
-- El checkout DEL CHAT sí marcaba `current_state = 'esperando_comprobante'`
-- (`marketplace-entry.ts`). El de la MINI APP —que es por donde pide todo el
-- mundo hoy— crea el pedido con `create_storefront_order` y **no tocaba la
-- conversación**: se quedaba en `navegando` con el candado puesto.
--
-- Con ese estado, el bot elige el mensaje de «estás a medio armar tu pedido»,
-- que es exactamente el que sobra cuando el pedido ya existe. Dos caminos para
-- lo mismo y solo uno avisaba.
--
-- ⚠️ Va en un DISPARADOR y no en la ruta de la tienda por la razón de siempre:
-- así vale para los dos caminos y para los que se escriban mañana. Es la misma
-- decisión que ya tomaron `orders_release_shopping_lock` y
-- `orders_clear_customer_strikes`.
--
-- ── CAUSA 2: irse a propósito costaba lo mismo que desaparecer ─────────────
--
-- Quien pulsa «Empezar de nuevo» está diciendo en voz alta que deja ese
-- pedido. Hasta ahora ese pedido se quedaba vivo hasta caducar, y al caducar
-- sumaba una falta de «pedido sin pagar» — la misma que suma quien nunca
-- volvió a contestar. **Avisar y desaparecer no pueden costar lo mismo**, o no
-- hay ningún motivo para avisar.
--
-- Ahora se CANCELA en el momento. `cancelado` y no `expirado`: expirar es que
-- se acabó el tiempo, cancelar es que alguien decidió. Aquí decidió el
-- cliente, y el historial tiene que poder distinguirlo.
--
-- ⚠️ NO cuenta como impago (`register_unpaid_expiry` no se llama), por lo
-- mismo que el comprobante falso no cuenta dos veces.
--
-- ⚠️ Solo `esperando_pago` y SIN comprobante: si ya mandó su foto, ese pedido
-- está en manos del dueño y el cliente no puede retirarlo.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. El pedido nuevo marca la conversación ───────────────────────────────
create or replace function public.orders_mark_awaiting_receipt()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.customer_id is null
     or coalesce(new.source, '') <> 'storefront'
     or new.status <> 'esperando_pago' then
    return new;
  end if;

  begin
    update public.marketplace_conversations as conv
       set current_state = 'esperando_comprobante',
           version       = conv.version + 1,
           updated_at    = now()
     where conv.customer_id = new.customer_id
       -- Solo si está en ESE local: si la conversación anda en otro sitio,
       -- pisarle el estado la sacaría de donde está.
       and conv.selected_business_id = new.business_id
       and conv.current_state <> 'esperando_comprobante';
  exception when others then
    -- El pedido ya existe. Un fallo marcando la conversación no puede
    -- deshacerlo: lo peor que pasa es que el bot dé el mensaje de antes.
    null;
  end;

  return new;
end;
$$;

drop trigger if exists orders_mark_awaiting_receipt on public.orders;
create trigger orders_mark_awaiting_receipt
  after insert on public.orders
  for each row execute function public.orders_mark_awaiting_receipt();

comment on function public.orders_mark_awaiting_receipt() is
  'Al crear un pedido que espera transferencia, la conversación pasa a '
  'esperando_comprobante. Sin esto el bot decía «termínalo» a quien ya había '
  'pedido: el checkout del chat avisaba y el de la mini app no.';

-- ── 2. Abandonar a propósito CANCELA, no caduca ────────────────────────────
create or replace function public.cancel_unpaid_order_on_purpose(
  p_business_id uuid,
  p_customer_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cancelados integer;
begin
  if p_business_id is null or p_customer_id is null then
    return 0;
  end if;

  with cancelados as (
    update public.orders
       set status = 'cancelado',
           updated_at = now()
     where business_id = p_business_id
       and customer_id = p_customer_id
       and status = 'esperando_pago'
       and coalesce(source, '') = 'storefront'
       -- Con la foto ya mandada, el pedido es del dueño: el cliente no puede
       -- retirarlo por su cuenta.
       and payment_proof_url is null
       and payment_confirmed_at is null
    returning 1
  )
  select count(*)::integer into v_cancelados from cancelados;

  return coalesce(v_cancelados, 0);
end;
$$;

comment on function public.cancel_unpaid_order_on_purpose(uuid, uuid) is
  'El cliente dijo en voz alta que deja el pedido: se cancela en el momento en '
  'vez de dejarlo caducar. Avisar y desaparecer no pueden costar lo mismo.';

revoke all on function public.cancel_unpaid_order_on_purpose(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_unpaid_order_on_purpose(uuid, uuid)
  to service_role;

-- ── Comprobación inmediata ─────────────────────────────────────────────────
do $comprobacion$
declare
  v_local   uuid;
  v_cliente uuid;
  v_pedido  uuid;
  v_conPago uuid;
  v_estado  text;
  v_n       integer;
  v_impagos integer;
begin
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders, chat_mode
  ) values (
    'aviso-uno-tmp', 'Pizza', 'pizzeria', 'ycloud',
    '+593900333501', '+593900333501', true, 'miniapp'
  ) returning id into v_local;

  insert into public.customers (phone) values ('593900333600') returning id into v_cliente;
  insert into public.business_customers (business_id, customer_id) values (v_local, v_cliente);
  insert into public.marketplace_conversations (
    customer_id, selected_business_id, shopping_locked, current_state
  ) values (v_cliente, v_local, true, 'navegando');

  -- ── 1. CREAR EL PEDIDO MARCA LA CONVERSACIÓN ────────────────────────────
  -- Es el fallo que vivió el dueño: pidió por la mini app y el bot le siguió
  -- diciendo «termínalo».
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_local, v_cliente, '593900333600', 'storefront', 'esperando_pago', 9, 9)
  returning id into v_pedido;

  select current_state into v_estado
    from public.marketplace_conversations where customer_id = v_cliente;
  if v_estado <> 'esperando_comprobante' then
    raise exception 'crear el pedido no avisó a la conversación: %', v_estado;
  end if;

  -- ── 2. ABANDONAR A PROPÓSITO CANCELA ────────────────────────────────────
  v_n := public.cancel_unpaid_order_on_purpose(v_local, v_cliente);
  if v_n <> 1 then
    raise exception 'debía cancelar 1 pedido y canceló %', v_n;
  end if;
  select status into v_estado from public.orders where id = v_pedido;
  if v_estado <> 'cancelado' then
    raise exception 'el pedido abandonado a propósito quedó en %', v_estado;
  end if;

  -- ── 3. Y NO se cuenta como impago ───────────────────────────────────────
  -- Avisar y desaparecer no pueden costar lo mismo.
  select unpaid_expiries into v_impagos
    from public.business_customers where business_id = v_local and customer_id = v_cliente;
  if coalesce(v_impagos, 0) <> 0 then
    raise exception 'irse avisando contó como impago: %', v_impagos;
  end if;

  -- ── 4. Con la foto ya mandada, el cliente NO puede retirarlo ────────────
  insert into public.orders (
    business_id, customer_id, contact_phone, source, status, subtotal, total, payment_proof_url
  ) values (v_local, v_cliente, '593900333600', 'storefront', 'esperando_pago', 7, 7, 'https://x/y.jpg')
  returning id into v_conPago;

  v_n := public.cancel_unpaid_order_on_purpose(v_local, v_cliente);
  if v_n <> 0 then
    raise exception 'canceló un pedido que YA tenía comprobante: %', v_n;
  end if;
  select status into v_estado from public.orders where id = v_conPago;
  if v_estado <> 'esperando_pago' then
    raise exception 'se tocó un pedido con comprobante: %', v_estado;
  end if;

  delete from businesses where id = v_local;
  delete from public.customers where id = v_cliente;
  raise notice 'EL PEDIDO AVISA: la conversación se entera, e irse avisando cancela sin multa';
end;
$comprobacion$;

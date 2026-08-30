-- ═══════════════════════════════════════════════════════════════════════════
-- EL CANDADO NO SE SUELTA AL MANDAR EL COMPROBANTE, SINO AL RESOLVERSE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Decisión del dueño (2026-08-30), después de probarlo él mismo: «que si el
-- cliente manda su comprobante, no pueda hacer pedidos hasta que termine de
-- pedir, así de simple… quiero que Umbani sea cerrado cuando usas WhatsApp».
--
-- ⚠️ REVIERTE, A PROPÓSITO, LA FRONTERA DEL 2026-08-30 (`candado-hasta-pagar`).
-- Aquella decía:
--
--   «En `pago_en_revision` ya mandó el comprobante y espera al DUEÑO.
--    Retenerlo ahí impediría pedir en otro local porque el local va lento —
--    castigar al cliente por algo que no depende de él.»
--
-- El razonamiento sigue siendo cierto y el dueño lo conoce: se le expuso y
-- eligió lo contrario. Su producto, su decisión — y tiene una razón que aquel
-- análisis no pesó: con el candado suelto, el cliente que acaba de mandar su
-- comprobante quedaba SIN LOCAL, así que cualquier mensaje suyo caía en el
-- menú del marketplace y recibía «🙏 No te entendí, ¿qué deseas pedir?» con la
-- lista de categorías. Lo vivió con el pedido #75: mandó una foto mientras su
-- comprobante estaba en revisión y el bot lo invitó a pedir en otro sitio.
--
-- El coste que se acepta a cambio: quien pide en un local lento no puede
-- comprar en otro hasta que ese local mire su pedido. Se acota solo, porque el
-- candado se suelta en CUALQUIER salida —aceptado, cancelado, rechazado o
-- caducado— y los pedidos sin pagar caducan a los 15 minutos.
--
-- ── LA FRONTERA NUEVA ──────────────────────────────────────────────────────
--
-- El candado dura mientras el pedido esté en `esperando_pago` o
-- `pago_en_revision`: los dos estados en los que el cliente ya encargó y el
-- local todavía no ha dicho que sí.
--
-- ⚠️ `pendiente` (EFECTIVO) se queda FUERA, y no es un olvido: ese pedido no
-- lleva comprobante, y `marketplace-entry` ya suelta el candado al crearlo
-- (`shoppingLocked: false`). Meterlo aquí daría dos reglas contradictorias
-- para el mismo pedido — una en TypeScript soltando y otra en la base
-- reteniendo—. La decisión del dueño habla del comprobante; esto es
-- exactamente eso y nada más.
--
-- ── Y LA CONVERSACIÓN TIENE QUE SABERLO ────────────────────────────────────
--
-- Al entrar en `pago_en_revision` se marca `current_state = 'pago_en_revision'`
-- CONSERVANDO el candado y el local. Sin esto, el bot le seguiría diciendo
-- «mándanos la foto de tu transferencia» a alguien que acaba de mandarla —
-- `recordarComprobantePendiente` se elige por ese estado.
--
-- ⚠️ Va en el MISMO disparador y no en TypeScript por la razón de siempre: los
-- estados los mueven `set_order_status` y `expire_unpaid_orders`, y el día que
-- entren los motorizados moverán más por vías nuevas. Nadie se va a acordar de
-- llamar a una función de Node desde ahí.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.orders_release_shopping_lock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Los dos estados en los que el cliente ya encargó y el local aún no dijo
  -- que sí. `pendiente` (efectivo) queda fuera: no lleva comprobante.
  v_retienen constant text[] := array['esperando_pago', 'pago_en_revision'];
begin
  if new.customer_id is null then
    return new;
  end if;

  -- ── Sigue debiendo: el candado se queda ─────────────────────────────────
  if new.status = any(v_retienen) then
    -- Pero la conversación tiene que saber en cuál de los dos está, o el bot
    -- le pedirá la foto a quien acaba de mandarla.
    if new.status = 'pago_en_revision' and old.status <> 'pago_en_revision' then
      begin
        update public.marketplace_conversations as conv
           set current_state = 'pago_en_revision',
               version       = conv.version + 1,
               updated_at    = now()
         where conv.customer_id = new.customer_id
           and conv.shopping_locked = true
           and conv.selected_business_id = new.business_id;
      exception when others then
        -- El pedido ya avanzó: un fallo aquí no puede tumbarlo.
        null;
      end;
    end if;
    return new;
  end if;

  -- ── Salió de los estados que retienen: se suelta ────────────────────────
  if not (old.status = any(v_retienen)) then
    return new;
  end if;

  begin
    -- ⚠️ Solo si no le quedan OTROS pedidos reteniendo. Alguien con dos a
    -- medias que resuelve uno sigue debiendo el otro; soltarle el candado ahí
    -- sería premiar el pago parcial con vía libre.
    if exists (
      select 1
      from public.orders as otro
      where otro.customer_id = new.customer_id
        and otro.id <> new.id
        and otro.source = 'storefront'
        and otro.status = any(v_retienen)
    ) then
      return new;
    end if;

    update public.marketplace_conversations as conv
       set shopping_locked     = false,
           -- Soltar el local va JUNTO con soltar el candado: el CHECK
           -- `marketplace_conversations_bloqueo_check` prohíbe estar bloqueado
           -- en ninguna parte, y dejar el local elegido sin candado haría que
           -- el siguiente mensaje entrara en un local que la persona ya
           -- terminó.
           selected_business_id = null,
           current_state        = 'navegando',
           flow_state           = null,
           version              = conv.version + 1,
           updated_at           = now()
     where conv.customer_id = new.customer_id
       and conv.shopping_locked = true;
  exception when others then
    null;
  end;

  return new;
end;
$$;

drop trigger if exists orders_release_shopping_lock on public.orders;
create trigger orders_release_shopping_lock
  after update of status on public.orders
  for each row execute function public.orders_release_shopping_lock();

comment on function public.orders_release_shopping_lock() is
  'El candado dura mientras el pedido esté en esperando_pago o pago_en_revision. '
  'Al entrar en revisión marca la conversación para que el bot no pida una foto '
  'que ya llegó. Decisión del dueño 2026-08-30: Umbani cerrado en WhatsApp.';

-- ── Comprobación inmediata ─────────────────────────────────────────────────
do $comprobacion$
declare
  v_local   uuid;
  v_otro    uuid;
  v_cliente uuid;
  v_pedido  uuid;
  v_segundo uuid;
  v_locked  boolean;
  v_estado  text;
  v_negocio uuid;
begin
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders, chat_mode
  ) values
    ('candado-cerrado-tmp', 'Pizza', 'pizzeria', 'ycloud', '+593900111001', '+593900111001', true, 'miniapp'),
    ('candado-otro-tmp', 'Otro', 'pizzeria', 'ycloud', '+593900111002', '+593900111002', true, 'miniapp');
  select id into v_local from businesses where slug = 'candado-cerrado-tmp';
  select id into v_otro  from businesses where slug = 'candado-otro-tmp';

  insert into public.customers (phone) values ('593900111100') returning id into v_cliente;
  insert into public.marketplace_conversations (
    customer_id, selected_business_id, shopping_locked, current_state
  ) values (v_cliente, v_local, true, 'esperando_comprobante');

  insert into public.orders (
    business_id, customer_id, contact_phone, source, status, subtotal, total
  ) values (v_local, v_cliente, '593900111100', 'storefront', 'esperando_pago', 9, 9)
  returning id into v_pedido;

  -- ── 1. MANDAR EL COMPROBANTE YA NO SUELTA EL CANDADO ────────────────────
  -- Es el cambio entero. Antes aquí quedaba libre y su siguiente mensaje caía
  -- en «🙏 No te entendí, ¿qué deseas pedir?».
  update public.orders set status = 'pago_en_revision' where id = v_pedido;
  select shopping_locked, current_state, selected_business_id
    into v_locked, v_estado, v_negocio
    from public.marketplace_conversations where customer_id = v_cliente;
  if not v_locked then
    raise exception 'mandar el comprobante soltó el candado';
  end if;
  if v_negocio is distinct from v_local then
    raise exception 'se perdió el local al mandar el comprobante';
  end if;
  -- Y el bot tiene que saber que la foto YA llegó.
  if v_estado <> 'pago_en_revision' then
    raise exception 'la conversación no supo que el comprobante está en revisión: %', v_estado;
  end if;

  -- ── 2. ACEPTARLO SÍ LO SUELTA ───────────────────────────────────────────
  update public.orders set status = 'preparacion' where id = v_pedido;
  select shopping_locked, selected_business_id into v_locked, v_negocio
    from public.marketplace_conversations where customer_id = v_cliente;
  if v_locked then
    raise exception 'aceptar el pedido NO soltó el candado';
  end if;
  if v_negocio is not null then
    raise exception 'se soltó el candado pero el local siguió elegido';
  end if;

  -- ── 3. CADUCAR TAMBIÉN LO SUELTA ────────────────────────────────────────
  -- Es lo que acota el coste de cerrar: un pedido sin pagar caduca solo.
  update public.marketplace_conversations
     set shopping_locked = true, selected_business_id = v_local,
         current_state = 'esperando_comprobante'
   where customer_id = v_cliente;
  insert into public.orders (
    business_id, customer_id, contact_phone, source, status, subtotal, total
  ) values (v_local, v_cliente, '593900111100', 'storefront', 'esperando_pago', 5, 5)
  returning id into v_segundo;
  update public.orders set status = 'expirado' where id = v_segundo;
  select shopping_locked into v_locked
    from public.marketplace_conversations where customer_id = v_cliente;
  if v_locked then
    raise exception 'caducar el pedido NO soltó el candado';
  end if;

  -- ── 4. CON DOS PEDIDOS ABIERTOS, RESOLVER UNO NO BASTA ──────────────────
  update public.marketplace_conversations
     set shopping_locked = true, selected_business_id = v_local
   where customer_id = v_cliente;
  insert into public.orders (
    business_id, customer_id, contact_phone, source, status, subtotal, total
  ) values (v_otro, v_cliente, '593900111100', 'storefront', 'pago_en_revision', 7, 7)
  returning id into v_segundo;
  insert into public.orders (
    business_id, customer_id, contact_phone, source, status, subtotal, total
  ) values (v_local, v_cliente, '593900111100', 'storefront', 'pago_en_revision', 6, 6)
  returning id into v_pedido;

  update public.orders set status = 'preparacion' where id = v_pedido;
  select shopping_locked into v_locked
    from public.marketplace_conversations where customer_id = v_cliente;
  if not v_locked then
    raise exception 'se soltó el candado con otro pedido todavía en revisión';
  end if;

  update public.orders set status = 'preparacion' where id = v_segundo;
  select shopping_locked into v_locked
    from public.marketplace_conversations where customer_id = v_cliente;
  if v_locked then
    raise exception 'resueltos los dos, el candado siguió puesto';
  end if;

  delete from businesses where id in (v_local, v_otro);
  delete from public.customers where id = v_cliente;
  raise notice 'CANDADO CERRADO: el comprobante no lo suelta; aceptar, cancelar o caducar sí';
end;
$comprobacion$;

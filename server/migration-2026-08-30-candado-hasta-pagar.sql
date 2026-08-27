-- ═══════════════════════════════════════════════════════════════════════════
-- EL CANDADO DURA HASTA QUE EL PEDIDO SE RESUELVE, Y EL TOPE ES DE LA PERSONA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Nace de un escenario que el dueño describió el 2026-08-30 y que, comprobado
-- contra el código, se colaba entero:
--
--   «Pide en la pizzería → no paga → escribe MENÚ → pide en la cevichería →
--    no paga → MENÚ → pide en el asadero…»
--
-- Dos agujeros lo hacían posible, y hacen falta LOS DOS para cerrarlo:
--
--  1. `orders_limit_open_per_customer` cuenta `business_id = new.business_id`.
--     Su propio mensaje lo delata: «Ya tienes pedidos sin confirmar EN ESTE
--     LOCAL». Un pedido abierto en cada local no llega nunca a tres en ninguno,
--     así que con quince locales se podían dejar quince comandas fantasma —
--     quince alarmas y quince cocinas preparando comida que nadie recoge.
--
--  2. `shopping_locked` se soltaba al CREAR el pedido
--     (`marketplace-entry.ts`: «El pedido existe: se suelta el local y el
--     bloqueo»). O sea que ni siquiera hacía falta escribir MENÚ para saltar
--     al siguiente local: bastaba con pedir.
--
-- Arreglar solo el 1 deja el salto libre y barato. Arreglar solo el 2 obliga a
-- teclear tres letras. Juntos, la persona tiene que resolver lo que debe.

-- ── 1. El tope también cuenta EN TODA LA PLATAFORMA ────────────────────────
--
-- ⚠️ Se AMPLÍA el disparador que ya existe en vez de añadir uno nuevo, y es a
-- propósito. `orders_reject_platform_blocked` sí se hizo aparte porque son
-- decisiones de PERSONAS distintas —el dueño bloquea su local, el superadmin
-- bloquea la plataforma— y el día que una falle hay que saber cuál actuó. Aquí
-- es UNA sola decisión, «cuántos pedidos sin pagar puede tener una persona»,
-- solo que mirada con dos alcances. Partirla daría dos frenos que hay que
-- mantener sincronizados y que se contradicen en cuanto alguien toque uno.
--
-- ⚠️ Los dos topes valen 3, así que en la práctica el de plataforma cubre al
-- de local. El de local se CONSERVA igualmente por dos motivos: da el mensaje
-- correcto —«en este local» dice qué hacer, «en Umbani» no—, y el día que se
-- afloje uno el otro sigue en pie. Un freno que solo existe cuando el otro
-- falla es exactamente para lo que sirve tener dos.
--
-- ⚠️ La ventana sigue siendo imprescindible, y ahora más: sin ella, tres
-- pedidos abandonados en tres locales distintos dejarían a esa persona sin
-- poder pedir en TODO Umbani para siempre. Con ventana, estorba seis horas.
-- Y los pedidos sin pagar caducan solos a los 120 minutos por defecto
-- (`payment_window_minutes`), así que en la práctica se suelta mucho antes.
--
-- ⚠️ Sigue acotado a `source = 'storefront'`. El de MOSTRADOR lo teclea el
-- dueño con la persona delante: si quiere meter cinco seguidos, es su cocina.
--
-- ⚠️ Cuenta lo que el dueño AÚN NO HA MIRADO. En cuanto acepta —`aceptado`,
-- `preparacion`— ese pedido deja de contar en los dos alcances.
--
-- ⚠️ Cuenta por `customer_id`, que es la PERSONA en toda la plataforma
-- (`customers.phone` es único). El día que existan los motorizados, ellos no
-- son clientes y tendrán su propia tabla: este freno no les alcanza, y se deja
-- escrito aquí para que nadie tenga que deducirlo.
create or replace function public.orders_limit_open_per_customer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_en_el_local     integer;
  v_en_la_plataforma integer;
  v_tope constant integer := 3;
  v_ventana constant interval := interval '6 hours';
  v_abiertos constant text[] := array['esperando_pago', 'pago_en_revision', 'pendiente'];
begin
  if coalesce(new.source, '') <> 'storefront' or new.customer_id is null then
    return new;
  end if;

  -- Un solo recorrido para los dos alcances: el índice
  -- `idx_orders_abiertos_por_cliente` ya cubre (business_id, customer_id,
  -- status, created_at), y contar dos veces sería pagar dos consultas por cada
  -- pedido nuevo para responder a la misma pregunta.
  select
    count(*) filter (where previo.business_id = new.business_id),
    count(*)
  into v_en_el_local, v_en_la_plataforma
  from public.orders as previo
  where previo.customer_id = new.customer_id
    and previo.source = 'storefront'
    and previo.status = any(v_abiertos)
    and previo.created_at > now() - v_ventana;

  -- El del LOCAL primero: cuando los dos se cumplen, su mensaje es el útil
  -- —dice dónde está el problema y por tanto qué hacer—.
  if v_en_el_local >= v_tope then
    raise exception using
      errcode = '42501',
      message = 'Ya tienes pedidos sin confirmar en este local. Espera a que los revisen antes de hacer otro.';
  end if;

  -- El de PLATAFORMA. El texto nombra Umbani a propósito: quien llega aquí ha
  -- pedido en varios locales, y decirle «en este local» lo mandaría a mirar el
  -- sitio equivocado. Y nombra la salida: pagar lo que debe.
  if v_en_la_plataforma >= v_tope then
    raise exception using
      errcode = '42501',
      message = 'Tienes varios pedidos sin confirmar en Umbani. Envía el comprobante de los que faltan y podrás pedir de nuevo.';
  end if;

  return new;
end;
$$;

-- ── 2. El candado se suelta cuando el pedido SE RESUELVE ───────────────────
--
-- ⚠️ VA EN UN DISPARADOR, no en `marketplace-entry.ts`, y es la parte que más
-- importa de esta migración. Todos los cambios de estado pasan hoy por la
-- base —`set_order_status` y `expire_unpaid_orders`, las dos RPC—, y ninguna
-- ruta escribe `orders.status` a mano. Puesto aquí, el candado se suelta por
-- CUALQUIER camino que resuelva un pedido, incluidos los que no existen
-- todavía: cuando entren los motorizados van a mover estados por vías nuevas,
-- y nadie va a acordarse de llamar a una función de TypeScript desde ahí.
--
-- Es la misma regla que ya siguieron `orders_reject_blocked`,
-- `orders_stamp_pricing` y `orders_limit_open_per_customer`.
--
-- ⚠️ QUÉ RETIENE EL CANDADO: solo `esperando_pago`, y NO los tres estados que
-- cuenta el tope de arriba. Son dos preguntas distintas:
--
--   · El TOPE protege la COCINA del local — comandas que el dueño no ha
--     mirado. Ahí `pendiente` y `pago_en_revision` sí estorban.
--   · El CANDADO pregunta «¿esta persona DEBE algo?». En `pago_en_revision` ya
--     mandó el comprobante y en `pendiente` (efectivo) no debe nada: los dos
--     esperan al DUEÑO. Retenerlo ahí impediría pedir en otro local porque el
--     local va lento, que es castigar al cliente por algo ajeno a él.
--
-- La regla del dueño era «tiene que enviar el comprobante». `esperando_pago`
-- es ese estado y ningún otro.
--
-- ⚠️ FALLA ABIERTO. El pedido ya cambió de estado cuando esto corre: la
-- comanda está en la cocina. Si soltar el candado fallara —no hay
-- conversación, la fila desapareció—, el pedido no puede caerse por eso. Es
-- el mismo criterio de `orders_reset_marketplace_reply`.
create or replace function public.orders_release_shopping_lock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- ⚠️ SOLO `esperando_pago`, y no los tres estados que cuenta el tope de
  -- arriba. Son dos preguntas distintas y confundirlas castiga a quien no debe:
  --
  --   · El TOPE protege la COCINA del local: cuenta comandas que el dueño aún
  --     no ha mirado, y ahí `pendiente` y `pago_en_revision` sí molestan.
  --   · El CANDADO responde «¿esta persona debe algo?». En `pago_en_revision`
  --     ya mandó su comprobante y en `pendiente` (efectivo) no debe nada: los
  --     dos esperan que el DUEÑO mire. Retener el candado ahí sería impedirle
  --     pedir en otro local porque el local va lento — castigar al cliente por
  --     algo que no depende de él.
  --
  -- La regla del dueño era «tiene que enviar el comprobante»; `esperando_pago`
  -- es exactamente ese estado y ningún otro.
  if old.status <> 'esperando_pago' or new.status = 'esperando_pago' then
    return new;
  end if;

  if new.customer_id is null then
    return new;
  end if;

  begin
    -- ⚠️ Solo se suelta si no le quedan OTROS comprobantes pendientes. Alguien
    -- con dos pedidos a medias que paga uno sigue debiendo el otro; soltarle
    -- el candado ahí sería premiar el pago parcial con vía libre.
    if exists (
      select 1
      from public.orders as otro
      where otro.customer_id = new.customer_id
        and otro.id <> new.id
        and otro.source = 'storefront'
        and otro.status = 'esperando_pago'
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
    -- El pedido ya avanzó. Un fallo soltando el candado se traga: lo peor que
    -- pasa es que la persona escriba MENÚ, que es la salida de siempre.
    null;
  end;

  return new;
end;
$$;

drop trigger if exists orders_release_shopping_lock on public.orders;
create trigger orders_release_shopping_lock
  after update of status on public.orders
  for each row execute function public.orders_release_shopping_lock();

-- El disparador busca «otros pedidos abiertos de esta persona» sin filtrar por
-- local, que es justo lo que el índice existente NO cubre: el suyo empieza por
-- `business_id`. Sin este, cada resolución de pedido recorrería `orders`.
create index if not exists idx_orders_abiertos_por_persona
  on public.orders (customer_id, status, created_at)
  where source = 'storefront';

comment on function public.orders_release_shopping_lock() is
  'Suelta `shopping_locked` cuando un pedido deja de estar abierto y a la '
  'persona no le quedan otros. Va en disparador para cubrir todos los caminos '
  'que resuelven pedidos, incluidos los que no existen todavía.';

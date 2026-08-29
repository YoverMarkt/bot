-- ════════════════════════════════════════════════════════════════════════
-- UN SOLO PEDIDO SIN PAGAR A LA VEZ
-- ════════════════════════════════════════════════════════════════════════
--
-- Lo encontró el dueño probando, el 2026-09-01, y es el hueco más caro que
-- quedaba: pidió, no pagó, volvió al chat, le dieron un enlace NUEVO y creó
-- otro pedido. El primero se quedó en el limbo hasta caducar.
--
-- Con el tope actual eso se puede hacer TRES veces: el dueño ve tres comandas
-- de la misma persona por un solo pedido real, prepara expectativas y aparta
-- stock para dos que nadie va a pagar.
--
-- ⚠️ Los dos frenos que ya existían NO cubrían este caso, y conviene entender
-- por qué antes de tocarlos:
--
--   · El TOPE (3 abiertos en 6 h) protege la COCINA: cuenta comandas que el
--     dueño no ha mirado. Tres es un número pensado para «no me llenes la
--     bandeja», no para «no debas dinero».
--   · El CANDADO de `esperando_pago` responde «¿esta persona debe algo?», pero
--     solo lo usa el bot para preguntar al escribir MENÚ. Nunca impidió
--     insertar nada.
--
-- Falta la regla que el dueño creía tener: **si debes un comprobante, no
-- puedes encargar otra cosa hasta resolverlo.**
--
-- ⚠️ Se cuenta en TODA LA PLATAFORMA, no por local. Quien debe un comprobante
-- en la pizzería y se va a la heladería a repetir la jugada está haciendo
-- exactamente lo mismo; y el número es único para todo Umbani, así que el
-- local nuevo no tiene forma de saberlo. Es la misma razón por la que el tope
-- ya mira los dos alcances.
--
-- ⚠️ `esperando_pago` y NADA MÁS. En `pago_en_revision` ya mandó su
-- comprobante y en `pendiente` (efectivo) no debe nada: los dos esperan al
-- DUEÑO. Retener ahí sería impedirle pedir porque el local va lento —
-- castigar al cliente por algo que no depende de él. Es la misma frontera que
-- ya eligió `orders_release_shopping_lock`, y las dos tienen que contar la
-- misma historia.
--
-- ⚠️ Solo `source = 'storefront'`. Un pedido de MOSTRADOR lo teclea el dueño
-- con la persona delante.
--
-- ⚠️ Y la VENTANA de 6 horas se mantiene, igual que en el tope: un pedido de
-- anteayer que nadie tocó no puede dejar a alguien sin poder comprar para
-- siempre. Lo normal es que caduque solo mucho antes.
create or replace function public.orders_limit_open_per_customer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_en_el_local      integer;
  v_en_la_plataforma integer;
  v_sin_pagar        integer;
  v_tope constant integer := 3;
  v_ventana constant interval := interval '6 hours';
  v_abiertos constant text[] := array['esperando_pago', 'pago_en_revision', 'pendiente'];
begin
  if coalesce(new.source, '') <> 'storefront' or new.customer_id is null then
    return new;
  end if;

  -- Un solo recorrido para los tres alcances: el índice
  -- `idx_orders_abiertos_por_cliente` ya cubre (business_id, customer_id,
  -- status, created_at), y contar tres veces sería pagar tres consultas por
  -- cada pedido nuevo para responder a preguntas que salen de la misma fila.
  select
    count(*) filter (where previo.business_id = new.business_id),
    count(*),
    count(*) filter (where previo.status = 'esperando_pago')
  into v_en_el_local, v_en_la_plataforma, v_sin_pagar
  from public.orders as previo
  where previo.customer_id = new.customer_id
    and previo.source = 'storefront'
    and previo.status = any(v_abiertos)
    and previo.created_at > now() - v_ventana;

  -- ── EL QUE FALTABA, y va PRIMERO ────────────────────────────────────────
  --
  -- Va antes que los otros dos porque es el más específico y el que mejor
  -- explica qué hacer: los topes dicen «tienes varios sin confirmar», que a
  -- quien debe UN comprobante no le dice nada útil.
  --
  -- El texto nombra la salida —mandar el comprobante— y no acusa: la mayoría
  -- de las veces es alguien que se distrajo, no alguien que está probando.
  if v_sin_pagar >= 1 then
    raise exception using
      errcode = '42501',
      message = 'Tienes un pedido esperando tu comprobante. Envíalo y podrás hacer otro.';
  end if;

  -- El del LOCAL: cuando los dos se cumplen, su mensaje es el útil —dice dónde
  -- está el problema y por tanto qué hacer—.
  if v_en_el_local >= v_tope then
    raise exception using
      errcode = '42501',
      message = 'Ya tienes pedidos sin confirmar en este local. Espera a que los revisen antes de hacer otro.';
  end if;

  -- El de PLATAFORMA. El texto nombra Umbani a propósito: quien llega aquí ha
  -- pedido en varios locales, y decirle «en este local» lo mandaría a mirar el
  -- sitio equivocado.
  if v_en_la_plataforma >= v_tope then
    raise exception using
      errcode = '42501',
      message = 'Tienes varios pedidos sin confirmar en Umbani. Envía el comprobante de los que faltan y podrás pedir de nuevo.';
  end if;

  return new;
end;
$$;

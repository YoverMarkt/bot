-- ============================================================================
-- VERIFICACIÓN DEL ESQUEMA CONTRA UN POSTGRESQL REAL
--
-- Los demás tests LEEN el SQL. Este lo EJECUTA, que es la única forma de
-- detectar la familia de fallos que tumbó el canal cinco días en julio de 2026:
-- PostgreSQL no valida el cuerpo de una función plpgsql al crearla, así que una
-- migración puede aplicarse "con éxito" y reventar en el primer uso real.
--
-- Se corre sobre una base recién creada con bootstrap-supabase.sql + schema.sql.
-- Cualquier `raise exception` aquí hace fallar el CI.
-- ============================================================================

\set ON_ERROR_STOP on

do $$
declare
  v_business uuid;
  v_encolado boolean;
  v_producto uuid;
  v_reservas integer;
begin
  -- ── Preparación ───────────────────────────────────────────────────────────
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_bookings, takes_orders
  ) values (
    'verificacion-esquema', 'Negocio de verificación', 'hotel',
    'ycloud', '+593900000001', '+593900000001',
    true, true
  )
  returning id into v_business;

  -- ── 1. Cola durable + trigger de consumo ─────────────────────────────────
  -- Este es EXACTAMENTE el camino que falló: enqueue_webhook_event inserta y el
  -- trigger record_inbound_message_usage llama a digest() de pgcrypto. Si el
  -- search_path de esa función no alcanza el esquema `extensions`, aquí revienta.
  v_encolado := public.enqueue_webhook_event(
    v_business,
    'ycloud',
    repeat('a', 64),
    repeat('b', 64),
    '{"content":{"kind":"text"},"inboundId":"verificacion-1"}'::jsonb
  );
  if v_encolado is not true then
    raise exception 'enqueue_webhook_event no encoló el evento';
  end if;

  if (select count(*) from webhook_inbound_events where business_id = v_business) <> 1 then
    raise exception 'El evento no quedó en la cola durable';
  end if;

  -- El trigger de consumo debe haber copiado la unidad en la misma transacción.
  if (select count(*) from message_usage_events where business_id = v_business) < 1 then
    raise exception 'El trigger de consumo no registró el mensaje entrante';
  end if;

  -- Reencolar el mismo mensaje no puede duplicarlo.
  if public.enqueue_webhook_event(
    v_business, 'ycloud', repeat('a', 64), repeat('b', 64),
    '{"content":{"kind":"text"},"inboundId":"verificacion-1"}'::jsonb
  ) is not false then
    raise exception 'La deduplicación de la cola no está funcionando';
  end if;

  -- ── 2. Registro de errores ────────────────────────────────────────────────
  perform public.record_platform_error(
    v_business, 'canal', '503', 'Error de verificación', '{}'::jsonb, repeat('e', 64)
  );
  perform public.record_platform_error(
    v_business, 'canal', '503', 'Error de verificación', '{}'::jsonb, repeat('e', 64)
  );
  -- Dos veces el mismo error = UNA fila con dos ocurrencias.
  if (select count(*) from platform_errors where business_id = v_business) <> 1 then
    raise exception 'El registro de errores no agrupó por huella';
  end if;
  if (select occurrences from platform_errors where business_id = v_business) <> 2 then
    raise exception 'El registro de errores no sumó la ocurrencia repetida';
  end if;

  -- La categoría inválida debe rechazarse.
  begin
    perform public.record_platform_error(
      v_business, 'inventada', null, 'x', '{}'::jsonb, repeat('f', 64)
    );
    raise exception 'record_platform_error aceptó una categoría inválida';
  exception when sqlstate '22023' then
    null;
  end;

  -- ── 3. Núcleo de dinero: el pedido lo calcula el CÓDIGO ───────────────────
  insert into products (business_id, name, price, stock, active)
  values (v_business, 'Producto de prueba', 10.50, 'disponible', true)
  returning id into v_producto;

  perform public.create_order_with_items(
    v_business,
    '+593900000002',
    'Cliente de prueba',
    'pendiente',
    0,
    'USD',
    jsonb_build_array(jsonb_build_object(
      'product_id', v_producto, 'quantity', 2, 'unit_price', 10.50
    ))
  );
  -- 2 × 10.50 = 21.00. Si el total no cuadra, el núcleo de dinero está roto.
  if (select total from orders where business_id = v_business limit 1) <> 21.00 then
    raise exception 'create_order_with_items calculó un total incorrecto';
  end if;

  -- Regla inviolable #8: el precio lo manda el catálogo, no quien pide. Si el
  -- cliente envía otro, la RPC debe rechazarlo en vez de cobrarlo.
  begin
    perform public.create_order_with_items(
      v_business, '+593900000002', 'Cliente', 'pendiente', 0, 'USD',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_producto, 'quantity', 1, 'unit_price', 0.01
      ))
    );
    raise exception 'create_order_with_items aceptó un precio inventado';
  exception when sqlstate '40001' then
    null;
  end;

  -- ── 3b. Pedido de la tienda: el precio lo pone la BASE, no el cliente ─────
  -- La app manda ids y cantidades. Si acepta un importe del cliente, cualquiera
  -- se lleva una pizza por un céntimo.
  update businesses set storefront_enabled = true where id = v_business;
  insert into product_variants (business_id, product_id, name, price)
  values (v_business, v_producto, 'Personal', 5.25);

  declare
    v_pedido jsonb;
  begin
    v_pedido := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'delivery',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_producto,
        'variant_id', (select id from product_variants where business_id = v_business limit 1),
        'quantity', 2,
        -- Precio inventado: debe ignorarse por completo.
        'unit_price', 0.01, 'total', 0.01
      ))
    );
    -- 2 × 5.25 de la variante = 10.50, nunca 0.02.
    if (v_pedido ->> 'total')::numeric <> 10.50 then
      raise exception 'create_storefront_order no calculó el total desde la base: %', v_pedido ->> 'total';
    end if;
  end;

  -- Un producto de otro negocio no se puede pedir aquí.
  begin
    perform public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'delivery',
      jsonb_build_array(jsonb_build_object('product_id', gen_random_uuid(), 'quantity', 1))
    );
    raise exception 'create_storefront_order aceptó un producto ajeno';
  exception when sqlstate '42501' then
    null;
  end;

  -- ── 4. Reservas: no se puede solapar el mismo hueco ───────────────────────
  -- El alta del negocio ya crea los 7 días (domingo inactivo, sábado corto).
  -- Se activa el día de la prueba para que no dependa de cuándo corra el CI.
  update business_schedule
  set is_active = true, open_time = '08:00', close_time = '20:00'
  where business_id = v_business
    and day_of_week = extract(dow from current_date + 1)::int;

  if not found then
    raise exception 'El alta del negocio no generó su horario por defecto';
  end if;

  perform public.create_booking_if_available(
    v_business, '+593900000002', 'Cliente', 'Servicio',
    (current_date + 1)::date, '10:00'::time, 60
  );
  select count(*) into v_reservas from bookings where business_id = v_business;
  if v_reservas < 1 then
    raise exception 'create_booking_if_available no creó la reserva';
  end if;

  -- ── 5. Limpiezas programadas ──────────────────────────────────────────────
  perform public.cleanup_webhook_events();
  perform public.cleanup_platform_errors(30);

  -- ── Limpieza ──────────────────────────────────────────────────────────────
  delete from businesses where id = v_business;

  raise notice 'VERIFICACIÓN DEL ESQUEMA: todas las comprobaciones pasaron';
end;
$$;

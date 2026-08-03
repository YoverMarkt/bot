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

-- ── 0. Dar de alta un cliente: la función que hace ganar dinero ────────────
--
-- Va PRIMERO y aparte porque es la más importante del sistema: sin ella no
-- entra ningún cliente nuevo. No estaba verificada, y el 2 de agosto de 2026
-- se descubrió que llevaba rota desde la migración de planes — el disparador
-- de la cuota mensual era BEFORE y su clave foránea apuntaba a una fila de
-- `billing` que aún no existía. El panel decía «No se pudo crear el cliente»
-- y el registro de errores no mostraba nada.
do $$
declare
  v_alta jsonb;
  v_nuevo uuid;
  v_cuotas integer;
begin
  v_alta := public.create_business_onboarding(
    jsonb_build_object(
      'name', 'Alta de verificación',
      'slug', 'alta-verificacion',
      'whatsapp_number', '+593900000900',
      'whatsapp_provider', 'ycloud',
      'ycloud_number', '+593900000900',
      'takes_orders', true,
      'plan', 'micro',
      'monthly_contact_limit', 50,
      'monthly_outbound_message_limit', 250
    ),
    'verificacion@ejemplo.com',
    '$2a$10$hashdepruebaquenoesunaclavereal00000000',
    25
  );

  v_nuevo := (v_alta ->> 'id')::uuid;
  if v_nuevo is null then
    raise exception 'create_business_onboarding no devolvió el negocio creado';
  end if;

  -- El alta es atómica: negocio, dueño, políticas y primera cuota o nada.
  if (select count(*) from client_users where business_id = v_nuevo) <> 1 then
    raise exception 'El alta no creó el usuario dueño';
  end if;
  if (select count(*) from bot_policies where business_id = v_nuevo) <> 1 then
    raise exception 'El alta no creó las políticas del negocio';
  end if;
  select count(*) into v_cuotas from billing where business_id = v_nuevo;
  if v_cuotas <> 1 then
    raise exception 'El alta debía dejar exactamente una cuota, dejó %', v_cuotas;
  end if;

  -- La cuota queda reclamada para su mes, y apuntando a la factura real: es
  -- justo la clave foránea que estaba rota.
  if not exists (
    select 1 from billing_month_claims c
    join billing b on b.id = c.billing_id
    where c.business_id = v_nuevo
  ) then
    raise exception 'La cuota del mes no quedó enlazada con su factura';
  end if;

  -- Un negocio no puede tener dos cuotas del mismo mes.
  begin
    insert into billing (business_id, amount, currency, status, period_start, period_end)
    values (
      v_nuevo, 25, 'USD', 'pending',
      date_trunc('month', current_date)::date,
      (date_trunc('month', current_date) + interval '1 month - 1 day')::date
    );
    raise exception 'La base aceptó dos cuotas del mismo mes para el mismo negocio';
  exception when sqlstate '23505' then
    null;
  end;

  delete from businesses where id = v_nuevo;
  raise notice 'ALTA DE CLIENTES: verificada';
end;
$$;

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

  -- Cambiar el estado de un pedido: lo pulsa el dueño en su panel cada día.
  declare
    v_pedido uuid;
    v_cambio jsonb;
  begin
    select id into v_pedido from orders where business_id = v_business limit 1;

    -- El estado sigue una máquina: pendiente → confirmado → completado. Saltarse
    -- un paso se rechaza en vez de dar por entregado algo que nadie confirmó.
    v_cambio := public.set_order_status(v_business, v_pedido, 'completado');
    if v_cambio ->> 'result' <> 'invalid_transition' then
      raise exception 'set_order_status aceptó completar un pedido sin confirmar: %', v_cambio;
    end if;

    perform public.set_order_status(v_business, v_pedido, 'confirmado');
    v_cambio := public.set_order_status(v_business, v_pedido, 'completado');
    if (select status from orders where id = v_pedido) <> 'completado' then
      raise exception 'set_order_status no cambió el estado: %', v_cambio;
    end if;
    -- Otro negocio no puede tocar este pedido.
    v_cambio := public.set_order_status(gen_random_uuid(), v_pedido, 'cancelado');
    if (select status from orders where id = v_pedido) <> 'completado' then
      raise exception 'FUGA: otro negocio cambió el estado de este pedido';
    end if;
  end;

  -- ── 3a. El camino del reparto: preparación → en camino → entregado ────────
  -- Es el flujo diario de una pizzería, y donde engancha la cooperativa.
  declare
    v_reparto uuid;
    v_cambio jsonb;
  begin
    insert into orders (business_id, contact_phone, status, total, fulfillment)
    values (v_business, '+593900000003', 'pendiente', 21.00, 'delivery')
    returning id into v_reparto;

    -- Aceptar y poner a preparar es un solo gesto: se permite saltar
    -- «confirmado» hacia adelante.
    perform public.set_order_status(v_business, v_reparto, 'preparacion');
    perform public.set_order_status(v_business, v_reparto, 'en_camino');
    if (select status from orders where id = v_reparto) <> 'en_camino' then
      raise exception 'set_order_status no dejó salir a reparto un pedido a domicilio';
    end if;

    -- Hacia atrás NUNCA: un pedido que ya salió no vuelve a la cocina.
    v_cambio := public.set_order_status(v_business, v_reparto, 'preparacion');
    if v_cambio ->> 'result' <> 'invalid_transition' then
      raise exception 'set_order_status permitió retroceder un pedido: %', v_cambio;
    end if;

    perform public.set_order_status(v_business, v_reparto, 'completado');
    if (select status from orders where id = v_reparto) <> 'completado' then
      raise exception 'set_order_status no pudo cerrar el pedido entregado';
    end if;

    -- ENTREGADO = VENDIDO. Los reportes leen `sales`: sin esto el negocio
    -- vendía y sus números decían que no.
    if not exists (select 1 from sales where order_id = v_reparto) then
      raise exception 'un pedido entregado no generó su venta';
    end if;
    if (select total from sales where order_id = v_reparto) <> 21.00 then
      raise exception 'la venta no heredó el total del pedido';
    end if;

    -- Reintentar no puede duplicar el dinero del reporte.
    perform public.set_order_status(v_business, v_reparto, 'completado');
    if (select count(*) from sales where order_id = v_reparto) <> 1 then
      raise exception 'marcar entregado dos veces duplicó la venta';
    end if;

    -- Otro negocio no puede convertir en venta un pedido ajeno.
    if public.crear_venta_desde_pedido(gen_random_uuid(), v_reparto) is not null then
      raise exception 'FUGA: otro negocio convirtió en venta un pedido ajeno';
    end if;
  end;

  -- Lo que el cliente RETIRA en el local no puede salir a la calle. Lo impide
  -- la base, no la pantalla: una pantalla se equivoca, un CHECK no.
  declare
    v_retiro uuid;
    v_cambio jsonb;
  begin
    insert into orders (business_id, contact_phone, status, total, fulfillment)
    values (v_business, '+593900000004', 'pendiente', 21.00, 'pickup')
    returning id into v_retiro;

    perform public.set_order_status(v_business, v_retiro, 'preparacion');
    v_cambio := public.set_order_status(v_business, v_retiro, 'en_camino');
    if v_cambio ->> 'result' <> 'not_deliverable' then
      raise exception 'set_order_status mandó a reparto un pedido de retiro: %', v_cambio;
    end if;

    -- Pero sí se entrega en mano, sin pasar por «en camino».
    perform public.set_order_status(v_business, v_retiro, 'completado');
    if (select status from orders where id = v_retiro) <> 'completado' then
      raise exception 'set_order_status no pudo entregar un pedido de retiro';
    end if;
  end;

  -- ── 3d. Pedido de mostrador: nace entregado y ya es venta ────────────────
  declare
    v_mostrador jsonb;
    v_id uuid;
  begin
    v_mostrador := public.create_order_with_items(
      v_business, 'mostrador', 'Cliente de paso', 'completado', 0, 'USD',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_producto, 'quantity', 1, 'unit_price', 10.50
      )),
      'manual'
    );
    v_id := (v_mostrador ->> 'id')::uuid;

    if not exists (select 1 from sales where order_id = v_id) then
      raise exception 'el pedido de mostrador no generó su venta';
    end if;
    -- 'mostrador' no es el teléfono de nadie: la venta va sin contacto, o el
    -- directorio de clientes acabaría con un cliente fantasma.
    if (select contact_phone from sales where order_id = v_id) is not null then
      raise exception 'la venta de mostrador guardó el teléfono postizo';
    end if;
    if (select source from sales where order_id = v_id) <> 'mostrador' then
      raise exception 'la venta de mostrador no registró su origen';
    end if;
  end;

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

  -- ── 3c. El envío lo pone la BASE, no el teléfono ─────────────────────────
  -- Si el costo de envío se calculara en la app, cualquiera pediría con envío
  -- $0 tocando el JavaScript. Aquí sale de la ficha del negocio.
  update businesses set delivery_fee = 2.00 where id = v_business;

  declare
    v_pedido jsonb;
    v_variante uuid;
  begin
    select id into v_variante from product_variants where business_id = v_business limit 1;

    v_pedido := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'delivery',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_producto, 'variant_id', v_variante, 'quantity', 2
      )),
      null, 'transferencia'
    );
    -- 10.50 de producto + 2.00 de envío.
    if (v_pedido ->> 'total')::numeric <> 12.50 or (v_pedido ->> 'shipping')::numeric <> 2.00 then
      raise exception 'create_storefront_order no sumó el envío: %', v_pedido;
    end if;

    -- Quien retira en el local NO paga envío.
    v_pedido := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'pickup',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_producto, 'variant_id', v_variante, 'quantity', 2
      )),
      null, 'efectivo'
    );
    if (v_pedido ->> 'total')::numeric <> 10.50 or (v_pedido ->> 'shipping')::numeric <> 0 then
      raise exception 'create_storefront_order cobró envío a un retiro en local: %', v_pedido;
    end if;

    -- Un método de pago que no existe se rechaza (la plataforma no cobra con
    -- tarjeta: regla inviolable #6).
    begin
      perform public.create_storefront_order(
        v_business, null, '+593900000002', 'Cliente', null, 'pickup',
        jsonb_build_array(jsonb_build_object('product_id', v_producto, 'quantity', 1)),
        null, 'tarjeta'
      );
      raise exception 'create_storefront_order aceptó un metodo de pago inventado';
    exception when sqlstate '22023' then
      null;
    end;

    -- ── El comprobante: solo el dueño del pedido puede adjuntarlo ───────────
    declare
      v_ultimo uuid;
      v_resultado jsonb;
    begin
      select id into v_ultimo from orders
      where business_id = v_business order by created_at desc limit 1;

      v_resultado := public.attach_storefront_payment_proof(
        v_business, v_ultimo, '+593900000002', 'https://res.cloudinary.com/demo/comprobante.jpg'
      );
      if v_resultado ->> 'result' <> 'updated' then
        raise exception 'attach_storefront_payment_proof no guardó el comprobante: %', v_resultado;
      end if;

      -- Otro teléfono con el id del pedido no puede colgarle nada.
      v_resultado := public.attach_storefront_payment_proof(
        v_business, v_ultimo, '+593900000099', 'https://res.cloudinary.com/demo/ajeno.jpg'
      );
      if v_resultado ->> 'result' <> 'not_found' then
        raise exception 'FUGA: otro cliente adjuntó un comprobante a este pedido';
      end if;

      -- Y otro negocio, tampoco.
      v_resultado := public.attach_storefront_payment_proof(
        gen_random_uuid(), v_ultimo, '+593900000002', 'https://res.cloudinary.com/demo/ajeno.jpg'
      );
      if v_resultado ->> 'result' <> 'not_found' then
        raise exception 'FUGA: otro negocio adjuntó un comprobante a este pedido';
      end if;
    end;
  end;

  -- Se deja como estaba para no contaminar las comprobaciones siguientes.
  update businesses set delivery_fee = 0 where id = v_business;

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

  -- ── 3e. Una cita atendida es una venta ───────────────────────────────────
  -- El caso de la barbería: sin esto, atender a alguien no aparecía en ningún
  -- reporte salvo que el dueño se acordara de registrarlo a mano.
  declare
    v_cita uuid;
    v_resultado jsonb;
  begin
    insert into bookings (
      business_id, contact_phone, contact_name, service, product_id, price,
      booking_date, booking_time, status
    ) values (
      v_business, '+593900000005', 'Cliente', 'Corte', v_producto, 10.50,
      current_date, '09:00', 'confirmed'
    ) returning id into v_cita;

    v_resultado := public.set_booking_status(v_business, v_cita, 'attended');
    if v_resultado ->> 'result' <> 'updated' then
      raise exception 'set_booking_status no pudo atender la cita: %', v_resultado;
    end if;
    if not exists (select 1 from sales where booking_id = v_cita) then
      raise exception 'una cita atendida no generó su venta';
    end if;

    -- Reintentar no duplica el dinero.
    perform public.set_booking_status(v_business, v_cita, 'attended');
    if (select count(*) from sales where booking_id = v_cita) <> 1 then
      raise exception 'atender dos veces duplicó la venta de la cita';
    end if;

    -- Una cita cerrada no se reabre.
    v_resultado := public.set_booking_status(v_business, v_cita, 'confirmed');
    if v_resultado ->> 'result' <> 'invalid_transition' then
      raise exception 'una cita atendida se pudo reabrir: %', v_resultado;
    end if;

    -- Otro negocio no puede cobrarse una cita ajena.
    if public.crear_venta_desde_cita(gen_random_uuid(), v_cita) is not null then
      raise exception 'FUGA: otro negocio convirtió en venta una cita ajena';
    end if;
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

  -- ── 5. Facturación del SaaS ───────────────────────────────────────────────
  -- Corren solas desde el arranque del servidor y desde el panel. Si revientan,
  -- se descubre el día que toca cobrar, no antes.
  -- Solo se factura a negocios activos con tarifa: se le pone una.
  update businesses set monthly_rate = 25, plan = 'micro' where id = v_business;
  perform public.ensure_current_month_billing();
  if (select count(*) from billing where business_id = v_business) < 1 then
    raise exception 'ensure_current_month_billing no generó la cuota del mes';
  end if;
  -- Correrla dos veces no puede duplicar el cobro del mismo mes.
  perform public.ensure_current_month_billing();
  if (select count(*) from billing where business_id = v_business) <> 1 then
    raise exception 'ensure_current_month_billing duplicó la cuota del mes';
  end if;

  perform public.update_business_plan_billing(v_business, 'pro', 99, 400, 2000);
  if (select plan from businesses where id = v_business) <> 'pro' then
    raise exception 'update_business_plan_billing no cambió el plan';
  end if;

  update businesses set suspended = true where id = v_business;
  perform public.reactivate_business_with_billing(v_business);
  if (select suspended from businesses where id = v_business) is not false then
    raise exception 'reactivate_business_with_billing no reactivó el negocio';
  end if;

  perform public.get_admin_monthly_usage(current_date);

  -- ── 6. Hospedaje: bloqueos y confirmación ────────────────────────────────
  declare
    v_room uuid;
    v_block jsonb;
    v_sobra jsonb;
  begin
    update businesses set lodging_enabled = true where id = v_business;
    insert into lodging_settings (business_id) values (v_business);
    insert into lodging_room_types (
      business_id, name, total_units, base_occupancy, max_guests,
      pricing_model, base_rate
    ) values (
      v_business, 'Habitación de verificación', 2, 2, 3, 'per_unit', 40
    )
    returning id into v_room;

    -- Un bloqueo manual (mantenimiento, reserva de otro canal) descuenta cupo.
    v_block := public.upsert_lodging_block_if_available(
      v_business, v_room, 'maintenance',
      (current_date + 10)::date, (current_date + 12)::date, 1, 'Verificación'
    );
    if v_block ->> 'result' is distinct from 'created' then
      raise exception 'upsert_lodging_block_if_available rechazó un bloqueo válido: %', v_block;
    end if;

    -- No se puede bloquear más unidades de las que existen.
    v_sobra := public.upsert_lodging_block_if_available(
      v_business, v_room, 'maintenance',
      (current_date + 10)::date, (current_date + 12)::date, 99, null
    );
    if v_sobra ->> 'result' <> 'unavailable' then
      raise exception 'La base aceptó bloquear más habitaciones de las que hay: %', v_sobra;
    end if;

    -- ── La cadena completa de una estadía ─────────────────────────────────
    -- Cotizar → solicitar → confirmar es lo que vive un huésped de verdad, y
    -- lo que pulsa el dueño en su panel. Se ejercita entera: si un eslabón
    -- revienta, la habitación queda en el limbo y nadie se entera.
    declare
      v_cotizacion jsonb;
      v_quote uuid;
      v_solicitud jsonb;
      v_request uuid;
      v_estado jsonb;
    begin
      v_cotizacion := public.quote_lodging_options(
        v_business, '+593900000003', 'Huésped de prueba',
        (current_date + 20)::date, (current_date + 22)::date, 2, 0, 1, null
      );
      if v_cotizacion ->> 'result' is distinct from 'quoted' then
        raise exception 'quote_lodging_options no cotizó: %', v_cotizacion;
      end if;
      v_quote := ((v_cotizacion -> 'quote') ->> 'id')::uuid;
      if v_quote is null then
        raise exception 'La cotización no devolvió su identificador: %', v_cotizacion;
      end if;

      v_solicitud := public.create_lodging_request_if_available(
        v_business, v_quote, v_room, '+593900000003', 'Huésped de prueba',
        repeat('d', 64), 'Verificación'
      );
      if v_solicitud ->> 'result' is distinct from 'created' then
        raise exception 'create_lodging_request_if_available no creó el hold: %', v_solicitud;
      end if;
      v_request := ((v_solicitud -> 'request') ->> 'id')::uuid;

      -- Nace PENDIENTE del equipo: nunca confirmada sola.
      if (select status from lodging_requests where id = v_request) <> 'pending_owner' then
        raise exception 'La solicitud no nació pendiente del dueño';
      end if;

      -- Pendiente NO es dinero: mientras no se confirme, no hay venta.
      if public.crear_venta_desde_estadia(v_business, v_request) is not null then
        raise exception 'una solicitud pendiente generó venta';
      end if;

      -- La v2 es la que llama el servidor: confirma y registra la venta en la
      -- misma transacción, sin tocar el anti-sobreventa de la original.
      v_estado := public.set_lodging_request_status_v2(v_business, v_request, 'confirmed');
      if (select status from lodging_requests where id = v_request) <> 'confirmed' then
        raise exception 'set_lodging_request_status_v2 no confirmó la solicitud: %', v_estado;
      end if;

      -- CONFIRMADA = VENDIDA. Sin esto, el ingreso de un hostal vivía en un
      -- reporte aparte y no se juntaba nunca con sus ventas.
      if not exists (select 1 from sales where lodging_request_id = v_request) then
        raise exception 'una estadía confirmada no generó su venta';
      end if;
      if (select s.total from sales s where s.lodging_request_id = v_request)
         <> (select r.total from lodging_requests r where r.id = v_request) then
        raise exception 'la venta de la estadía no heredó su total';
      end if;

      -- Reintentar no duplica el dinero.
      perform public.crear_venta_desde_estadia(v_business, v_request);
      if (select count(*) from sales where lodging_request_id = v_request) <> 1 then
        raise exception 'confirmar dos veces duplicó la venta de la estadía';
      end if;

      -- Otro negocio no puede cobrarse una estadía ajena.
      if public.crear_venta_desde_estadia(gen_random_uuid(), v_request) is not null then
        raise exception 'FUGA: otro negocio se cobró una estadía ajena';
      end if;

      -- Un negocio no puede tocar la solicitud de otro.
      v_estado := public.set_lodging_request_status(
        gen_random_uuid(), v_request, 'cancelled'
      );
      if (select status from lodging_requests where id = v_request) <> 'confirmed' then
        raise exception 'FUGA: otro negocio cambió el estado de esta solicitud';
      end if;

      -- Los holds vencidos dejan de ocupar cupo por su cuenta.
      perform public.expire_lodging_holds(v_business);

      -- Y el bloqueo manual se puede levantar.
      v_estado := public.release_lodging_block(
        v_business, (v_block -> 'block' ->> 'id')::uuid
      );
      if v_estado ->> 'result' is distinct from 'released' then
        raise exception 'release_lodging_block no liberó el bloqueo: %', v_estado;
      end if;
    end;
  end;

  -- ── 7. Limpiezas programadas ──────────────────────────────────────────────
  perform public.cleanup_webhook_events();
  perform public.cleanup_platform_errors(30);
  perform public.cleanup_storefront_sessions(2);

  -- ── Limpieza ──────────────────────────────────────────────────────────────
  delete from businesses where id = v_business;

  raise notice 'VERIFICACIÓN DEL ESQUEMA: todas las comprobaciones pasaron';
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- NINGUNA FUNCIÓN PROPIA PUEDE TENER DOS VERSIONES VIVAS
-- ═══════════════════════════════════════════════════════════════════════════
-- `create or replace function` con un parámetro nuevo NO reemplaza: crea una
-- SEGUNDA función con el mismo nombre. Las dos quedan vivas y cualquier
-- llamada se vuelve ambigua — el código viejo sigue ahí, invisible.
--
-- Las sobrecargas de las extensiones (pgvector, pgcrypto, btree_gist) son
-- legítimas y se excluyen: solo se miran las funciones del proyecto, que son
-- las que están declaradas en schema.sql.
do $$
declare
  v_duplicadas text;
begin
  select string_agg(format('%s (%s versiones)', proname, veces), ', ')
  into v_duplicadas
  from (
    select p.proname, count(*) as veces
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    left join pg_depend d
      on d.objid = p.oid and d.deptype = 'e'   -- pertenece a una extensión
    where n.nspname = 'public'
      and p.prokind = 'f'
      and d.objid is null
    group by p.proname
    having count(*) > 1
  ) as repetidas;

  if v_duplicadas is not null then
    raise exception 'Funciones del proyecto con más de una versión viva: %', v_duplicadas;
  end if;
end;
$$;

select '✅ sin funciones duplicadas' as resultado;

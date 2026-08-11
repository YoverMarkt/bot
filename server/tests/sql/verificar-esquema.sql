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

  -- ── El payload EXACTO del pedido de mostrador ────────────────────────────
  --
  -- El panel manda solo ids y cantidades a propósito («el precio NO viaja»),
  -- y eso hacía saltar el control de precio: `null is distinct from 10.50` es
  -- cierto, así que el mostrador fallaba SIEMPRE con 40001. Un camino del
  -- dinero entero que nunca funcionó desde que se publicó, y que ninguna
  -- prueba veía porque todas mandaban `unit_price`.
  --
  -- Por eso este bloque manda lo que manda la ruta, no lo que es cómodo.
  declare
    v_sin_precio jsonb;
  begin
    v_sin_precio := public.create_order_with_items(
      v_business, 'mostrador', 'Cliente en local', 'completado', 0, 'USD',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_producto, 'quantity', 3
      )),
      'manual'
    );
    if (v_sin_precio ->> 'total')::numeric <> 31.50 then
      raise exception 'sin unit_price el total salió %, esperaba 31.50',
        v_sin_precio ->> 'total';
    end if;

    -- Y mandar un precio EQUIVOCADO se sigue rechazando: lo que se relaja es
    -- la ausencia, no el control.
    begin
      perform public.create_order_with_items(
        v_business, '+593900000002', 'Listillo', 'pendiente', 0, 'USD',
        jsonb_build_array(jsonb_build_object(
          'product_id', v_producto, 'quantity', 1, 'unit_price', 0.01
        ))
      );
      raise exception 'create_order_with_items aceptó un precio falso';
    exception when sqlstate '40001' then
      null;  -- rechazado como debe
    end;
  end;

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

  -- ── 3b-bis. Todo pedido nace NUMERADO ────────────────────────────────────
  -- La pantalla de confirmación lee `order_number`, y un pedido sin número deja
  -- al cliente sin nada que reclamar y al dueño con un UUID que no se dicta por
  -- teléfono. Lo pone un trigger para que valga por TODOS los caminos —bot,
  -- mostrador, mini app y el Marketplace del futuro—, no solo por el que se
  -- acordó de hacerlo.
  declare
    v_uno jsonb;
    v_dos jsonb;
    v_otro_negocio uuid;
    v_numero_otro integer;
  begin
    v_uno := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'pickup',
      jsonb_build_array(jsonb_build_object('product_id', v_producto, 'quantity', 1))
    );
    v_dos := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'pickup',
      jsonb_build_array(jsonb_build_object('product_id', v_producto, 'quantity', 1))
    );

    if (v_uno ->> 'order_number') is null then
      raise exception 'un pedido nació sin número: %', v_uno;
    end if;
    -- Correlativo: el siguiente es exactamente el siguiente, sin huecos.
    if (v_dos ->> 'order_number')::int <> (v_uno ->> 'order_number')::int + 1 then
      raise exception 'los números no son correlativos: % y %',
        v_uno ->> 'order_number', v_dos ->> 'order_number';
    end if;

    -- Y la cuenta es POR NEGOCIO: el primer pedido de otro local empieza en 1,
    -- no continúa la numeración del vecino.
    insert into businesses (slug, name, whatsapp_number)
    values ('numeracion-aparte', 'Otro local', '+593900000777')
    returning id into v_otro_negocio;
    insert into products (business_id, name, price)
    values (v_otro_negocio, 'Algo', 3.00);

    insert into orders (business_id, contact_phone, subtotal, total)
    values (v_otro_negocio, '+593900000888', 3.00, 3.00)
    returning order_number into v_numero_otro;

    if v_numero_otro <> 1 then
      raise exception 'la numeración no es por negocio: el otro local empezó en %', v_numero_otro;
    end if;
  end;

  -- ── 3b-ter. El flujo del pedido, contado como es ─────────────────────────
  -- Quien va a TRANSFERIR nace esperando el pago, no «pendiente»: el dueño
  -- tiene que poder distinguir a quien le pagará en la puerta de aquel del que
  -- aún no ha visto un centavo.
  declare
    v_transfer jsonb;
    v_efectivo jsonb;
    v_estado text;
    v_paso jsonb;
  begin
    v_transfer := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'pickup',
      jsonb_build_array(jsonb_build_object('product_id', v_producto, 'quantity', 1)),
      null, 'transferencia'
    );
    select status into v_estado from public.orders where id = (v_transfer ->> 'id')::uuid;
    if v_estado is distinct from 'esperando_pago' then
      raise exception 'una transferencia debía nacer esperando el pago, nació en %', v_estado;
    end if;

    v_efectivo := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'pickup',
      jsonb_build_array(jsonb_build_object('product_id', v_producto, 'quantity', 1)),
      null, 'efectivo'
    );
    select status into v_estado from public.orders where id = (v_efectivo ->> 'id')::uuid;
    if v_estado is distinct from 'pendiente' then
      raise exception 'un pedido en efectivo debía nacer pendiente, nació en %', v_estado;
    end if;

    -- «Aceptar y preparar» es UN paso: desde el comprobante en revisión se
    -- puede ir directo a la cocina. Antes estaba prohibido a propósito.
    v_paso := public.set_order_status(
      v_business, (v_transfer ->> 'id')::uuid, 'pago_en_revision');
    v_paso := public.set_order_status(
      v_business, (v_transfer ->> 'id')::uuid, 'preparacion');
    if v_paso ->> 'result' is distinct from 'updated' then
      raise exception '«aceptar y preparar» desde pago_en_revision falló: %', v_paso ->> 'result';
    end if;

    -- Y lo que sigue prohibido, sigue prohibido: nada retrocede.
    v_paso := public.set_order_status(
      v_business, (v_transfer ->> 'id')::uuid, 'pendiente');
    if v_paso ->> 'result' is distinct from 'invalid_transition' then
      raise exception 'un pedido en preparación pudo volver a pendiente: %', v_paso ->> 'result';
    end if;
  end;

  -- ── 3b-quater. El pedido se QUEDA con la dirección ───────────────────────
  --
  -- `address_id` es una foránea `on delete set null`, y el panel leía la
  -- dirección a través de ella. O sea que el pedido no guardaba a dónde iba:
  -- preguntaba a dónde va HOY esa dirección. El cliente la corregía a media
  -- entrega y la pantalla del repartidor cambiaba debajo de él; la borraba y el
  -- pedido se quedaba sin dirección para siempre.
  --
  -- Es la misma regla que ya cumplían los productos: `order_items` congela
  -- `product_name` y `unit_price` para que el pedido de ayer siga diciendo lo
  -- que el cliente compró.
  declare
    v_cliente uuid;
    v_direccion uuid;
    v_pedido jsonb;
    v_congelada text;
    v_lat numeric;
    v_apunta uuid;
  begin
    insert into public.customers (phone, name)
    values ('593900000123', 'Cliente con casa')
    returning id into v_cliente;

    insert into public.customer_addresses (
      business_id, customer_id, label, address, reference,
      latitude, longitude, accuracy_m, building_type, courier_notes
    ) values (
      v_business, v_cliente, 'Casa', 'Calle 4 de Mayo 37', 'junto a la farmacia',
      -1.0546210, -80.4544720, 12.5, 'casa', 'el timbre no sirve, toca la puerta'
    ) returning id into v_direccion;

    v_pedido := public.create_storefront_order(
      v_business, v_cliente, '593900000123', 'Cliente con casa',
      v_direccion, 'delivery',
      jsonb_build_array(jsonb_build_object('product_id', v_producto, 'quantity', 1))
    );

    -- Nace con la fotografía puesta, no con un puntero.
    select delivery_address, delivery_latitude
      into v_congelada, v_lat
      from public.orders where id = (v_pedido ->> 'id')::uuid;
    if v_congelada is distinct from 'Calle 4 de Mayo 37' then
      raise exception 'el pedido no copió la dirección: %', coalesce(v_congelada, '(nula)');
    end if;
    if v_lat is distinct from -1.0546210 then
      raise exception 'el pedido no copió el pin: %', coalesce(v_lat::text, '(nulo)');
    end if;

    -- El cliente se muda. El pedido de antes sigue yendo a donde iba.
    update public.customer_addresses
       set address = 'Otra casa, otro barrio', latitude = 0, longitude = 0
     where id = v_direccion;

    select delivery_address into v_congelada
      from public.orders where id = (v_pedido ->> 'id')::uuid;
    if v_congelada is distinct from 'Calle 4 de Mayo 37' then
      raise exception 'editar la dirección cambió un pedido ya hecho: %', v_congelada;
    end if;

    -- Y la borra. `address_id` se queda en nulo —así está declarada la
    -- foránea— pero la dirección del pedido no se va con ella.
    delete from public.customer_addresses where id = v_direccion;

    select delivery_address, address_id into v_congelada, v_apunta
      from public.orders where id = (v_pedido ->> 'id')::uuid;
    if v_apunta is not null then
      raise exception 'la foránea dejó de ser «set null», el borrado no la limpió';
    end if;
    if v_congelada is distinct from 'Calle 4 de Mayo 37' then
      raise exception 'borrar la dirección dejó el pedido sin destino: %',
        coalesce(v_congelada, '(nula)');
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

  -- ── 3d bis. Las opciones entran al pedido ────────────────────────────────
  --
  -- El motor de opciones estuvo tres migraciones en la base sin que nadie lo
  -- leyera. Esto ejercita lo que decide el DINERO: que el recargo salga de la
  -- base, que los obligatorios se exijan aquí y no en el navegador, y que
  -- `order_item_options` quede escrita.
  declare
    v_categoria_op uuid;
    v_producto_op uuid;
    v_grupo_obligatorio uuid;
    v_grupo_contador uuid;
    v_op_normal uuid;
    v_op_negativa uuid;
    v_op_contador uuid;
    v_grupo_ajeno uuid;
    v_op_ajena uuid;
    v_producto_ajeno uuid;
    v_pedido_op jsonb;
    v_item_op uuid;
  begin
    insert into product_categories (business_id, name)
    values (v_business, 'Almuerzos') returning id into v_categoria_op;
    insert into products (business_id, name, price, stock, active, category_id)
    values (v_business, 'Almuerzo del día', 3.00, 'disponible', true, v_categoria_op)
    returning id into v_producto_op;
    insert into products (business_id, name, price, stock, active)
    values (v_business, 'Producto sin grupos', 5.00, 'disponible', true)
    returning id into v_producto_ajeno;

    -- Un grupo OBLIGATORIO que cuelga de la categoría.
    insert into option_groups (
      business_id, category_id, name, selection_type, required, min_selectable, max_selectable
    ) values (v_business, v_categoria_op, 'Sopa', 'single', true, 1, 1)
    returning id into v_grupo_obligatorio;
    insert into options (business_id, option_group_id, name, price_adjustment)
    values (v_business, v_grupo_obligatorio, 'Sopa del día', 0)
    returning id into v_op_normal;
    -- El recargo NEGATIVO, que es la razón de que la columna lo admita.
    insert into options (business_id, option_group_id, name, price_adjustment)
    values (v_business, v_grupo_obligatorio, 'Sin sopa', -0.50)
    returning id into v_op_negativa;

    -- Un contador: 3 porciones repartidas entre cortes.
    insert into option_groups (
      business_id, product_id, name, selection_type, required, min_selectable, max_selectable
    ) values (v_business, v_producto_op, 'Cortes', 'quantity', false, 0, 3)
    returning id into v_grupo_contador;
    insert into options (business_id, option_group_id, name, price_adjustment)
    values (v_business, v_grupo_contador, 'Lomo', 1.00)
    returning id into v_op_contador;

    -- Y un grupo que NO aplica a este producto, para probar la frontera.
    insert into option_groups (business_id, product_id, name)
    values (v_business, v_producto_ajeno, 'Ajeno') returning id into v_grupo_ajeno;
    insert into options (business_id, option_group_id, name, price_adjustment)
    values (v_business, v_grupo_ajeno, 'Opción de otro plato', -2.00)
    returning id into v_op_ajena;

    -- OBLIGATORIO: sin elegir sopa, el pedido no se crea.
    begin
      perform public.create_storefront_order(
        v_business, null, '+593900000002', 'Cliente', null, 'pickup',
        jsonb_build_array(jsonb_build_object('product_id', v_producto_op, 'quantity', 1))
      );
      raise exception 'create_storefront_order aceptó un pedido sin el grupo obligatorio';
    exception when sqlstate '22023' then null;
    end;

    -- FRONTERA: una opción de otro producto no puede abaratar este.
    begin
      perform public.create_storefront_order(
        v_business, null, '+593900000002', 'Cliente', null, 'pickup',
        jsonb_build_array(jsonb_build_object(
          'product_id', v_producto_op, 'quantity', 1,
          'options', jsonb_build_array(
            jsonb_build_object('option_id', v_op_normal, 'quantity', 1),
            jsonb_build_object('option_id', v_op_ajena, 'quantity', 1)
          )
        ))
      );
      raise exception 'FUGA: una opción de otro producto entró al pedido';
    exception when sqlstate '42501' then null;
    end;

    -- Repetir la misma opción multiplicaría su recargo por la puerta de atrás.
    begin
      perform public.create_storefront_order(
        v_business, null, '+593900000002', 'Cliente', null, 'pickup',
        jsonb_build_array(jsonb_build_object(
          'product_id', v_producto_op, 'quantity', 1,
          'options', jsonb_build_array(
            jsonb_build_object('option_id', v_op_negativa, 'quantity', 1),
            jsonb_build_object('option_id', v_op_negativa, 'quantity', 1)
          )
        ))
      );
      raise exception 'create_storefront_order aceptó la misma opción repetida';
    exception when sqlstate '22023' then null;
    end;

    -- Y pedir por cantidad en un grupo que no es contador, tampoco.
    begin
      perform public.create_storefront_order(
        v_business, null, '+593900000002', 'Cliente', null, 'pickup',
        jsonb_build_array(jsonb_build_object(
          'product_id', v_producto_op, 'quantity', 1,
          'options', jsonb_build_array(
            jsonb_build_object('option_id', v_op_negativa, 'quantity', 6)
          )
        ))
      );
      raise exception 'create_storefront_order multiplicó una opción que no es contador';
    exception when sqlstate '22023' then null;
    end;

    -- El caso legítimo: 3.00 − 0.50 de «sin sopa» + 2 porciones de lomo a 1.00.
    v_pedido_op := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'pickup',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_producto_op, 'quantity', 1,
        'options', jsonb_build_array(
          jsonb_build_object('option_id', v_op_negativa, 'quantity', 1),
          jsonb_build_object('option_id', v_op_contador, 'quantity', 2)
        )
      ))
    );
    if (v_pedido_op ->> 'total')::numeric <> 4.50 then
      raise exception 'el recargo de las opciones no se calculó en la base: %', v_pedido_op;
    end if;

    select oi.id into v_item_op
    from order_items oi
    where oi.order_id = (v_pedido_op ->> 'id')::uuid;

    -- La fotografía de lo elegido, congelada con su precio.
    if (select count(*) from order_item_options where order_item_id = v_item_op) <> 2 then
      raise exception 'order_item_options no guardó lo que eligió el cliente';
    end if;
    if not exists (
      select 1 from order_item_options
      where order_item_id = v_item_op and option_name = 'Lomo'
        and quantity = 2 and unit_price_adjustment = 1.00
        and total_price_adjustment = 2.00
    ) then
      raise exception 'order_item_options no congeló bien la cantidad y su importe';
    end if;
    if not exists (
      select 1 from order_item_options
      where order_item_id = v_item_op and option_name = 'Sin sopa'
        and total_price_adjustment = -0.50
    ) then
      raise exception 'order_item_options perdió el signo de un recargo negativo';
    end if;

    -- Y lo que el DUEÑO ve en su panel sigue diciendo qué se pidió: si las
    -- opciones solo fueran a la tabla nueva, el pedido se vería vacío.
    if not exists (
      select 1 from order_items
      where id = v_item_op
        and 'Sin sopa' = any(extras_names)
        and 'Lomo x2' = any(extras_names)
    ) then
      raise exception 'las opciones no llegaron a extras_names: el dueño no vería qué pidieron';
    end if;

    -- ── Las ocho estrategias de precio ─────────────────────────────────────
    --
    -- El caso que las justifica: media Suprema ($10) y media Hawaiana ($9) con
    -- `sum` costarían $19 —el doble de una pizza—. Aquí se comprueba que cada
    -- estrategia cobre lo que dice, con el MISMO grupo y las MISMAS opciones.
    declare
      v_grupo_precio uuid;
      v_barata uuid;
      v_cara uuid;
      v_media uuid;
      v_estrategia text;
      v_esperado numeric;
      v_pedido_e jsonb;
    begin
      -- Grupo de tres opciones: 1.00, 2.00 y 4.00 sobre un plato de 3.00.
      insert into option_groups (
        business_id, product_id, name, selection_type, max_selectable, pricing_strategy
      ) values (v_business, v_producto_op, 'Precios', 'multiple', 3, 'sum')
      returning id into v_grupo_precio;
      insert into options (business_id, option_group_id, name, price_adjustment)
      values (v_business, v_grupo_precio, 'Barata', 1.00) returning id into v_barata;
      insert into options (business_id, option_group_id, name, price_adjustment)
      values (v_business, v_grupo_precio, 'Media', 2.00) returning id into v_media;
      insert into options (business_id, option_group_id, name, price_adjustment)
      values (v_business, v_grupo_precio, 'Cara', 4.00) returning id into v_cara;

      foreach v_estrategia in array array[
        'sum', 'fixed', 'included', 'highest_selected', 'lowest_selected',
        'average', 'included_up_to_limit', 'extra_after_limit'
      ]
      loop
        update option_groups
        set pricing_strategy = v_estrategia, free_selections =
          case when v_estrategia in ('included_up_to_limit', 'extra_after_limit')
            then 1 else 0 end
        where id = v_grupo_precio;

        -- Base 3.00 + las tres opciones (1, 2 y 4), y el grupo obligatorio.
        v_pedido_e := public.create_storefront_order(
          v_business, null, '+593900000002', 'Cliente', null, 'pickup',
          jsonb_build_array(jsonb_build_object(
            'product_id', v_producto_op, 'quantity', 1,
            'options', jsonb_build_array(
              jsonb_build_object('option_id', v_op_normal, 'quantity', 1),
              jsonb_build_object('option_id', v_barata, 'quantity', 1),
              jsonb_build_object('option_id', v_media, 'quantity', 1),
              jsonb_build_object('option_id', v_cara, 'quantity', 1)
            )
          ))
        );

        v_esperado := 3.00 + case v_estrategia
          when 'sum' then 7.00                  -- 1 + 2 + 4
          when 'fixed' then 0.00                -- no altera el precio
          when 'included' then 0.00
          when 'highest_selected' then 4.00     -- la mitad y mitad
          when 'lowest_selected' then 1.00
          when 'average' then 2.33              -- (1+2+4)/3, redondeado
          when 'included_up_to_limit' then 3.00 -- la de 4.00 va incluida
          when 'extra_after_limit' then 3.00    -- una porción incluida, la cara
        end;

        if (v_pedido_e ->> 'total')::numeric <> v_esperado then
          raise exception 'La estrategia % cobró % y debía cobrar %',
            v_estrategia, v_pedido_e ->> 'total', v_esperado;
        end if;
        delete from orders where id = (v_pedido_e ->> 'id')::uuid;
      end loop;

      -- Y el caso del contador: `extra_after_limit` gasta el cupo en PORCIONES,
      -- así que una misma opción puede quedar a medias.
      update option_groups
      set selection_type = 'quantity', pricing_strategy = 'extra_after_limit',
          free_selections = 2, max_selectable = 5
      where id = v_grupo_precio;

      v_pedido_e := public.create_storefront_order(
        v_business, null, '+593900000002', 'Cliente', null, 'pickup',
        jsonb_build_array(jsonb_build_object(
          'product_id', v_producto_op, 'quantity', 1,
          'options', jsonb_build_array(
            jsonb_build_object('option_id', v_op_normal, 'quantity', 1),
            jsonb_build_object('option_id', v_cara, 'quantity', 3)
          )
        ))
      );
      -- 3 porciones a 4.00, dos incluidas: se cobra una → 3.00 + 4.00
      if (v_pedido_e ->> 'total')::numeric <> 7.00 then
        raise exception 'El cupo por porciones cobró %, y debía cobrar 7.00',
          v_pedido_e ->> 'total';
      end if;
      delete from orders where id = (v_pedido_e ->> 'id')::uuid;

      delete from option_groups where id = v_grupo_precio;
    end;

    -- Limpieza para no contaminar lo que viene después.
    delete from orders where id = (v_pedido_op ->> 'id')::uuid;
    delete from option_groups where business_id = v_business;
    delete from products where id in (v_producto_op, v_producto_ajeno);
    delete from product_categories where id = v_categoria_op;
  end;

  -- ── 3d ter. Un doble toque NO crea dos pedidos ───────────────────────────
  --
  -- Es el fallo más caro de una tienda: dos comandas en la cocina y un cliente
  -- que paga dos veces. La app manda una clave por intento de compra.
  declare
    v_uno jsonb;
    v_dos jsonb;
    v_sin_clave jsonb;
    v_pedido_idem uuid;
  begin
    v_uno := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'pickup',
      jsonb_build_array(jsonb_build_object('product_id', v_producto, 'quantity', 1)),
      null, null, 'clave-del-cliente'
    );
    v_dos := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'pickup',
      jsonb_build_array(jsonb_build_object('product_id', v_producto, 'quantity', 1)),
      null, null, 'clave-del-cliente'
    );

    if (v_uno ->> 'id') <> (v_dos ->> 'id') then
      raise exception 'La misma clave creó DOS pedidos';
    end if;
    if (v_dos ->> 'repetido')::boolean is not true then
      raise exception 'El segundo intento no se avisó como repetido';
    end if;

    -- Sin clave se siguen creando pedidos distintos: el bot no la manda, y
    -- dos personas pidiendo lo mismo son dos pedidos.
    v_sin_clave := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'pickup',
      jsonb_build_array(jsonb_build_object('product_id', v_producto, 'quantity', 1))
    );
    if (v_sin_clave ->> 'id') = (v_uno ->> 'id') then
      raise exception 'Sin clave se reutilizó un pedido anterior';
    end if;

    -- ── El historial de estados ────────────────────────────────────────────
    v_pedido_idem := (v_uno ->> 'id')::uuid;
    perform public.set_order_status(v_business, v_pedido_idem, 'confirmado');
    perform public.set_order_status(v_business, v_pedido_idem, 'preparacion');

    if (select count(*) from order_events where order_id = v_pedido_idem) <> 2 then
      raise exception 'El historial no registró los dos cambios de estado';
    end if;
    -- De dónde venía, no solo a dónde fue: sin el origen no se puede auditar.
    if not exists (
      select 1 from order_events
      where order_id = v_pedido_idem
        and from_status = 'confirmado' and to_status = 'preparacion'
    ) then
      raise exception 'El historial no guardó de qué estado venía el pedido';
    end if;

    -- ── Los estados nuevos y sus límites ───────────────────────────────────
    -- Un pedido de retiro no sale a reparto…
    if (public.set_order_status(v_business, v_pedido_idem, 'en_camino') ->> 'result')
       <> 'not_deliverable' then
      raise exception 'Un pedido de retiro salió a reparto';
    end if;
    -- …pero sí puede quedar listo para retirar.
    if (public.set_order_status(v_business, v_pedido_idem, 'listo_para_retiro') ->> 'result')
       <> 'updated' then
      raise exception 'Un pedido de retiro no pudo quedar listo para retirar';
    end if;

    -- Y de un estado FINAL no se vuelve atrás.
    perform public.set_order_status(v_business, v_pedido_idem, 'cancelado');
    if (public.set_order_status(v_business, v_pedido_idem, 'preparacion') ->> 'result')
       <> 'invalid_transition' then
      raise exception 'Un pedido cancelado volvió a preparación';
    end if;

    delete from orders where id in (v_pedido_idem, (v_sin_clave ->> 'id')::uuid);
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
      -- Sus dos hermanas, `crear_venta_desde_pedido` y `crear_venta_desde_cita`,
      -- no comprobaban esto hasta el 2026-08-02: cobraban un pedido cancelado.
      -- La comprobación de las tres está en el bloque 7.
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

      -- ── Borrar la estadía no puede reventar por su propia venta ─────────
      -- Va al final a propósito: se lleva por delante la solicitud, así que
      -- nada de lo anterior podría seguir usándola.
      --
      -- La foránea de `sales` hacia `lodging_requests` es compuesta sobre
      -- (id, business_id) para que nadie se cobre lo del vecino. Pero con
      -- `on delete set null` a secas PostgreSQL anulaba TAMBIÉN `business_id`,
      -- que es NOT NULL, y el borrado moría con 23502 (2026-08-02).
      -- `verificar-fronteras.sql` no lo veía: vigila la FORMA de la foránea,
      -- y la forma era correcta; lo roto era la ACCIÓN de borrado.
      declare
        v_venta_estadia uuid;
        v_negocio_venta uuid;
      begin
        select id into v_venta_estadia
        from sales where lodging_request_id = v_request;

        delete from lodging_requests where id = v_request;

        select business_id into v_negocio_venta
        from sales where id = v_venta_estadia;
        if v_negocio_venta is distinct from v_business then
          raise exception
            'Borrar la estadía dejó su venta sin negocio (business_id = %)',
            v_negocio_venta;
        end if;
      end;
    end;
  end;

  -- ── 7. El dinero solo nace en el estado correcto ──────────────────────────
  --
  -- Las tres funciones que crean ventas comprobaban el negocio y la
  -- idempotencia, pero dos de ellas no miraban el ESTADO del origen. Medido
  -- contra PostgreSQL real el 2026-08-02:
  --
  --   ⚠️ crear_venta_desde_pedido cobró un pedido en estado "cancelado"
  --
  -- Estaban protegidas solo por sus llamadores (`set_order_status` y
  -- `set_booking_status`), y eso basta hasta que alguien las llame directo:
  -- son SECURITY DEFINER y están concedidas a `service_role`, que es el rol
  -- con el que el servidor habla con Supabase.
  declare
    v_pedido_cancelado uuid;
    v_cita_cancelada uuid;
  begin
    insert into orders (business_id, contact_phone, status, total)
    values (v_business, '+593900000404', 'cancelado', 20.00)
    returning id into v_pedido_cancelado;
    if public.crear_venta_desde_pedido(v_business, v_pedido_cancelado) is not null then
      raise exception 'un pedido cancelado generó venta';
    end if;

    insert into bookings (
      business_id, contact_phone, service, price, booking_date, booking_time, status
    ) values (
      v_business, '+593900000404', 'Corte', 20.00, current_date + 5, '16:00', 'cancelled'
    ) returning id into v_cita_cancelada;
    if public.crear_venta_desde_cita(v_business, v_cita_cancelada) is not null then
      raise exception 'una cita cancelada generó venta';
    end if;

    -- Y el camino legítimo sigue funcionando: una cerradura que también deja
    -- fuera al dueño no sirve de nada.
    update orders set status = 'completado' where id = v_pedido_cancelado;
    if public.crear_venta_desde_pedido(v_business, v_pedido_cancelado) is null then
      raise exception 'un pedido completado no generó su venta';
    end if;

    update bookings set status = 'attended' where id = v_cita_cancelada;
    if public.crear_venta_desde_cita(v_business, v_cita_cancelada) is null then
      raise exception 'una cita atendida no generó su venta';
    end if;
  end;

  -- ── 7 bis. Modo mini app: el enlace se manda una vez cada 24 h ───────────
  --
  -- Es lo que decide si el bot manda el enlace o solo recuerda que lo usen.
  -- Vivía en un `Map` del proceso, que se perdía al reiniciar y no servía con
  -- dos instancias; ahora lo reclama la base, de forma atómica, porque tres
  -- «hola» seguidos son lo normal y no pueden mandar tres enlaces.
  declare
    v_cliente uuid;
    v_toca boolean;
  begin
    insert into public.customers (phone) values ('593900000707')
    returning id into v_cliente;

    v_toca := public.claim_storefront_link_send(v_business, v_cliente, 24);
    if v_toca is not true then
      raise exception 'la primera vez debía reclamar el envío del enlace';
    end if;

    v_toca := public.claim_storefront_link_send(v_business, v_cliente, 24);
    if v_toca is not false then
      raise exception 'dentro de la ventana de 24 h NO debía reenviar';
    end if;

    update public.business_customers
    set storefront_link_sent_at = now() - interval '25 hours'
    where business_id = v_business and customer_id = v_cliente;

    v_toca := public.claim_storefront_link_send(v_business, v_cliente, 24);
    if v_toca is not true then
      raise exception 'pasadas 24 h debía volver a mandar el enlace';
    end if;

    -- El mismo cliente en OTRO negocio lleva su propia cuenta: que un local le
    -- haya mandado su enlace no puede dejar sin enlace al de al lado.
    declare
      v_otro uuid;
    begin
      insert into businesses (
        slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
        takes_orders
      ) values (
        'verificacion-enlace-b', 'Vecino', 'tienda', 'ycloud',
        '+593900000708', '+593900000708', true
      ) returning id into v_otro;

      if public.claim_storefront_link_send(v_otro, v_cliente, 24) is not true then
        raise exception 'el envío de un negocio bloqueó el de otro';
      end if;

      delete from businesses where id = v_otro;
    end;

    delete from public.customers where id = v_cliente;
  end;

  -- ── 8. Limpiezas programadas ──────────────────────────────────────────────
  perform public.cleanup_webhook_events();
  perform public.cleanup_platform_errors(30);
  perform public.cleanup_storefront_sessions(2);

  -- ── Limpieza ──────────────────────────────────────────────────────────────
  delete from businesses where id = v_business;

  raise notice 'VERIFICACIÓN DEL ESQUEMA: todas las comprobaciones pasaron';
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- LA PLANTILLA DEL TIPO DE NEGOCIO
-- ═══════════════════════════════════════════════════════════════════════════
-- Va en su propio bloque porque necesita negocios RECIÉN creados: el de arriba
-- ya tiene catálogo, y el portón de la función —que es justo lo que hay que
-- comprobar— lo rechazaría por el motivo correcto, dando un falso verde.
do $plantillas$
declare
  v_limpio uuid; v_ocupado uuid;
  v_resultado jsonb;
  v_plantilla jsonb := jsonb_build_object('categorias', jsonb_build_array(
    jsonb_build_object(
      'nombre', 'Hamburguesas', 'orden', 0,
      'grupos', jsonb_build_array(
        jsonb_build_object(
          'nombre', 'Término de la carne', 'tipo', 'single',
          'obligatorio', true, 'min', 1, 'max', 1,
          'opciones', jsonb_build_array(
            jsonb_build_object('nombre', 'Tres cuartos'),
            jsonb_build_object('nombre', 'Bien cocida')
          )
        ),
        jsonb_build_object(
          'nombre', 'Extras', 'tipo', 'multiple', 'max', 6,
          'opciones', jsonb_build_array(
            jsonb_build_object('nombre', 'Tocino', 'recargo', 1)
          )
        )
      )
    ),
    jsonb_build_object('nombre', 'Bebidas', 'orden', 1)
  ));
begin
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders)
  values ('verif-plantilla-limpio', 'Limpio', 'hamburguesería', 'ycloud',
    '+593900888001', '+593900888001', true)
  returning id into v_limpio;
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders)
  values ('verif-plantilla-ocupado', 'Ocupado', 'hamburguesería', 'ycloud',
    '+593900888002', '+593900888002', true)
  returning id into v_ocupado;

  v_resultado := public.apply_business_template(v_limpio, v_plantilla);
  if (v_resultado->>'aplicada')::boolean is not true
     or (v_resultado->>'categorias')::integer <> 2
     or (v_resultado->>'grupos')::integer <> 2
     or (v_resultado->>'opciones')::integer <> 3 then
    raise exception 'apply_business_template no cargó la plantilla: %', v_resultado;
  end if;

  -- Lo que hace útil a la plantilla: el grupo existe SIN productos todavía, y
  -- conserva su obligatoriedad y su recargo.
  if not exists (
    select 1 from option_groups
    where business_id = v_limpio and product_id is null and category_id is not null
      and name = 'Término de la carne' and required and min_selectable = 1
  ) then
    raise exception 'el grupo obligatorio de la plantilla no quedó bien colgado';
  end if;
  if not exists (
    select 1 from options o
    join option_groups og on og.id = o.option_group_id
    where og.business_id = v_limpio and o.name = 'Tocino' and o.price_adjustment = 1
  ) then
    raise exception 'la plantilla perdió el recargo de una opción';
  end if;

  -- El portón: sobre un negocio con catálogo no toca nada.
  insert into product_categories (business_id, name) values (v_ocupado, 'Ya existía');
  v_resultado := public.apply_business_template(v_ocupado, v_plantilla);
  if (v_resultado->>'aplicada')::boolean is not false
     or (select count(*) from product_categories where business_id = v_ocupado) <> 1 then
    raise exception 'apply_business_template pisó un negocio con catálogo: %', v_resultado;
  end if;

  -- Y un negocio inexistente se rechaza en vez de sembrar filas sueltas.
  begin
    perform public.apply_business_template(gen_random_uuid(), v_plantilla);
    raise exception 'apply_business_template aceptó un negocio inexistente';
  exception when insufficient_privilege then null;
  end;

  delete from businesses where id in (v_limpio, v_ocupado);
  raise notice 'PLANTILLAS DE NEGOCIO: carga, portón y negocio inexistente comprobados';
end;
$plantillas$;

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

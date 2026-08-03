-- ============================================================================
-- EL PEDIDO DE MOSTRADOR NUNCA FUNCIONÓ
--
-- `POST /api/client/orders` —la venta en persona, publicada el 2026-08-02—
-- fallaba SIEMPRE. No a veces: siempre, desde el primer día.
--
-- La ruta manda solo ids y cantidades, a propósito, y lo dice en su comentario:
--
--     El precio NO viaja: se mandan ids y cantidades y la RPC resuelve cada
--     importe del catálogo (regla inviolable #8).
--
-- Esa era la intención. La RPC nunca la implementó: comparaba el precio
-- recibido con el del catálogo mediante
--
--     if v_requested_price is distinct from v_unit_price then  -- 40001
--
-- y con `unit_price` ausente `v_requested_price` es null, así que
-- `null is distinct from 2.75` da CIERTO y el pedido se rechazaba con
-- «El precio cambió; vuelve a calcular el pedido».
--
-- Por qué no lo vio nadie: el bot sí manda `unit_price` (se lo pone
-- `money.computeOrder`), la tienda usa otra función distinta
-- (`create_storefront_order`), y TODAS las pruebas —las de esquema y las de
-- ruta— mandaban precio. La única llamada del sistema que no lo manda es
-- justo la que estaba rota, y su test de ruta falsea la capa `db`, así que
-- nunca llegó a la función de verdad.
--
-- El arreglo distingue AUSENTE de DISTINTO:
--
--   · ausente  → «no tengo opinión, usa tu catálogo»  (mostrador)
--   · presente → se confirma contra el catálogo o se rechaza  (bot)
--
-- No se relaja ningún control: mandar un precio equivocado se sigue
-- rechazando con 40001, y el importe sigue saliendo solo del catálogo en los
-- dos casos. Lo que se arregla es que «no decir nada» dejara de tratarse como
-- «decir algo incorrecto».
--
-- Idempotente: `create or replace`. No toca datos.
-- ============================================================================

create or replace function public.create_order_with_items(
  p_business_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_status text,
  p_discount numeric,
  p_currency text,
  p_items jsonb,
  p_source text default 'whatsapp'
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_order orders%rowtype;
  v_item jsonb;
  v_normalized_items jsonb := '[]'::jsonb;
  v_product_id uuid;
  v_product_name text;
  v_product_stock text;
  v_quantity integer;
  v_requested_price numeric(10,2);
  v_unit_price numeric(10,2);
  v_line_total numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_discount numeric(10,2) := round(coalesce(p_discount, 0), 2);
  v_total numeric(10,2);
begin
  if p_business_id is null then
    raise exception using errcode = '22023', message = 'El negocio es obligatorio';
  end if;
  if nullif(btrim(p_contact_phone), '') is null then
    raise exception using errcode = '22023', message = 'El contacto es obligatorio';
  end if;
  if coalesce(p_status, 'pendiente') not in (
    'pendiente', 'confirmado', 'completado', 'cancelado', 'expirado'
  ) then
    raise exception using errcode = '22023', message = 'Estado de pedido inválido';
  end if;
  if coalesce(p_source, 'whatsapp') not in ('whatsapp', 'storefront', 'marketplace', 'manual') then
    raise exception using errcode = '22023', message = 'Origen de pedido inválido';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'El pedido necesita al menos un ítem';
  end if;
  if v_discount < 0 then
    raise exception using errcode = '22023', message = 'El descuento no puede ser negativo';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Cada ítem debe ser un objeto';
    end if;
    v_product_id := nullif(v_item ->> 'product_id', '')::uuid;
    v_quantity := (v_item ->> 'quantity')::integer;
    v_requested_price := round((v_item ->> 'unit_price')::numeric, 2);
    if v_product_id is null then
      raise exception using errcode = '22023', message = 'El producto es obligatorio';
    end if;
    if v_quantity < 1 or v_quantity > 99 then
      raise exception using errcode = '22023', message = 'La cantidad debe estar entre 1 y 99';
    end if;
    select
      p.name,
      round(case when p.price_sale > 0 then p.price_sale else p.price end, 2),
      p.stock
    into v_product_name, v_unit_price, v_product_stock
    from products p
    where p.id = v_product_id
      and p.business_id = p_business_id
      and p.active = true
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'El producto no pertenece al negocio';
    end if;
    if v_product_stock = 'agotado' then
      raise exception using errcode = '22023', message = 'El producto está agotado';
    end if;
    if not (v_unit_price > 0) then
      raise exception using errcode = '22023', message = 'El producto no tiene un precio válido';
    end if;
    -- El precio que manda quien llama es una OPINIÓN que hay que confirmar,
    -- no un dato que se acepte: si no coincide con el catálogo, el pedido se
    -- rehace. Así el bot no puede cobrar un precio que ya cambió mientras el
    -- cliente decidía.
    --
    -- Pero ausente NO es lo mismo que distinto: significa «no tengo opinión,
    -- usa tu catálogo». Sin esta distinción, `null is distinct from 2.75` daba
    -- cierto y el pedido de MOSTRADOR —que a propósito manda solo ids y
    -- cantidades— fallaba SIEMPRE con 40001. Nunca funcionó desde que se
    -- publicó (2026-08-02), y ninguna prueba lo veía porque todas mandaban
    -- precio. El precio sigue saliendo solo del catálogo en los dos casos.
    if v_requested_price is not null and v_requested_price is distinct from v_unit_price then
      raise exception using errcode = '40001', message = 'El precio cambió; vuelve a calcular el pedido';
    end if;
    v_line_total := round(v_quantity * v_unit_price, 2);
    v_subtotal := v_subtotal + v_line_total;
    v_normalized_items := v_normalized_items || jsonb_build_array(jsonb_build_object(
      'product_id', v_product_id, 'product_name', v_product_name,
      'quantity', v_quantity, 'unit_price', v_unit_price, 'line_total', v_line_total
    ));
  end loop;

  v_subtotal := round(v_subtotal, 2);
  if v_discount > v_subtotal then
    raise exception using errcode = '22023', message = 'El descuento supera el subtotal';
  end if;
  v_total := round(v_subtotal - v_discount, 2);

  insert into orders (
    business_id, contact_phone, contact_name, status,
    subtotal, discount, total, currency, source
  ) values (
    p_business_id, btrim(p_contact_phone), nullif(btrim(p_contact_name), ''),
    coalesce(p_status, 'pendiente'), v_subtotal, v_discount, v_total,
    coalesce(nullif(btrim(p_currency), ''), 'USD'), coalesce(p_source, 'whatsapp')
  ) returning * into v_order;

  insert into order_items (
    order_id, business_id, product_id, product_name, quantity, unit_price, line_total
  )
  select
    v_order.id, p_business_id, nullif(item ->> 'product_id', '')::uuid,
    item ->> 'product_name', (item ->> 'quantity')::integer,
    (item ->> 'unit_price')::numeric, (item ->> 'line_total')::numeric
  from jsonb_array_elements(v_normalized_items) as item;

  -- Nace entregado (mostrador): la venta se crea aquí, no en una segunda
  -- llamada desde Node que podría no ocurrir si algo falla entre medias.
  if coalesce(p_status, 'pendiente') = 'completado' then
    perform public.crear_venta_desde_pedido(p_business_id, v_order.id);
  end if;

  return to_jsonb(v_order);
end;
$$;

revoke all on function public.create_order_with_items(uuid, text, text, text, numeric, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.create_order_with_items(uuid, text, text, text, numeric, text, jsonb, text)
  to service_role;

-- ── Comprobación inmediata ──────────────────────────────────────────────────
-- Se ejercita el payload EXACTO del mostrador, no uno cómodo.
do $comprobacion$
declare
  v_b uuid; v_p uuid; v_r jsonb;
begin
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_bookings, takes_orders
  ) values (
    'mostrador-tmp', 'Mostrador', 'tienda', 'ycloud',
    '+593900666001', '+593900666001', false, true
  ) returning id into v_b;

  insert into products (business_id, name, price, stock, active)
  values (v_b, 'Producto', 4.25, 'disponible', true) returning id into v_p;

  -- Sin unit_price: es lo que manda la ruta.
  v_r := public.create_order_with_items(
    v_b, 'mostrador', 'En local', 'completado', 0, 'USD',
    jsonb_build_array(jsonb_build_object('product_id', v_p, 'quantity', 4)),
    'manual'
  );
  if (v_r ->> 'total')::numeric <> 17.00 then
    raise exception 'sin unit_price el total salió %, esperaba 17.00', v_r ->> 'total';
  end if;
  if not exists (select 1 from sales where order_id = (v_r ->> 'id')::uuid) then
    raise exception 'el pedido de mostrador no generó su venta';
  end if;

  -- Con un precio FALSO: se sigue rechazando.
  begin
    perform public.create_order_with_items(
      v_b, '+593900666002', 'Listillo', 'pendiente', 0, 'USD',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_p, 'quantity', 1, 'unit_price', 0.01
      ))
    );
    raise exception 'se aceptó un precio falso';
  exception when sqlstate '40001' then
    null;
  end;

  delete from businesses where id = v_b;
  raise notice 'MOSTRADOR: sin precio usa el catálogo; con precio falso rechaza';
end;
$comprobacion$;

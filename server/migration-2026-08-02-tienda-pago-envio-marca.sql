-- ═══════════════════════════════════════════════════════════════════════════
-- TIENDA: COSTO DE ENVÍO, MÉTODO DE PAGO, COMPROBANTE Y COLOR DE MARCA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Completa el flujo del diagrama del dueño. Tres decisiones tomadas con él:
--   · El envío es un MONTO FIJO por negocio, y solo se cobra a domicilio.
--   · El comprobante es OPCIONAL: sin él el pedido entra igual.
--   · El color de marca lo elige cada negocio; el verde de la plataforma es
--     solo el valor por defecto.
--
-- ⚠️ REGLA INVIOLABLE #8: el envío es dinero, así que se suma AQUÍ, en la
-- base, junto al subtotal. La app manda ids y cantidades; jamás importes. Si
-- el envío se calculara en el teléfono, cualquiera pediría con envío $0.
--
-- Idempotente. Aplicar con `npm run migrate`.

-- ── 1. Configuración del negocio ──────────────────────────────────────────
alter table public.businesses
  add column if not exists delivery_fee numeric(10,2) not null default 0,
  add column if not exists brand_color text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.businesses'::regclass and conname = 'businesses_tienda_check'
  ) then
    alter table public.businesses add constraint businesses_tienda_check check (
      delivery_fee >= 0 and delivery_fee <= 999
      -- Hex de 6 dígitos: es lo que produce un selector de color y lo único
      -- que se puede inyectar sin riesgo en un estilo.
      and (brand_color is null or brand_color ~ '^#[0-9a-fA-F]{6}$')
    );
  end if;
end;
$$;

-- ── 2. El pedido guarda cómo se paga y cuánto costó llevarlo ──────────────
alter table public.orders
  add column if not exists shipping numeric(10,2) not null default 0,
  add column if not exists payment_method text,
  add column if not exists payment_proof_url text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass and conname = 'orders_pago_check'
  ) then
    -- `payment_method` queda nulo en los pedidos del bot por WhatsApp, que no
    -- preguntan cómo se paga. La tarjeta no existe: la plataforma no cobra.
    alter table public.orders add constraint orders_pago_check check (
      shipping >= 0
      and (payment_method is null or payment_method in ('transferencia', 'efectivo'))
    );
  end if;
end;
$$;

-- ── 3. El pedido de la tienda, ahora con envío y método de pago ───────────
-- Cambia la firma, así que se retira la anterior: dejar las dos vivas haría
-- ambigua cualquier llamada.
drop function if exists public.create_storefront_order(
  uuid, uuid, text, text, uuid, text, jsonb, text
);

create or replace function public.create_storefront_order(
  p_business_id uuid,
  p_customer_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_address_id uuid,
  p_fulfillment text,
  p_items jsonb,
  p_notes text default null,
  p_payment_method text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business record;
  v_order_id uuid;
  v_item jsonb;
  v_product record;
  v_variant record;
  v_has_variant boolean;
  v_variant_ref uuid;
  v_variant_label text;
  v_product_id uuid;
  v_variant_id uuid;
  v_quantity integer;
  v_note text;
  v_extra_ids uuid[];
  v_extras_total numeric(10,2);
  v_extras_names text[];
  v_unit_price numeric(10,2);
  v_line_total numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_shipping numeric(10,2) := 0;
  v_count integer := 0;
begin
  -- ── El negocio debe poder recibir pedidos por la tienda ──────────────────
  select id, active, suspended, storefront_enabled, takes_orders, delivery_fee
  into v_business
  from public.businesses
  where id = p_business_id
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'El negocio no existe';
  end if;
  if v_business.active is false or v_business.suspended is true then
    raise exception using errcode = '42501', message = 'El negocio no esta disponible';
  end if;
  if v_business.storefront_enabled is not true then
    raise exception using errcode = '42501', message = 'Este negocio no tiene tienda activada';
  end if;
  if v_business.takes_orders is not true then
    raise exception using errcode = '42501', message = 'Este negocio no recibe pedidos';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'El pedido no tiene productos';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception using errcode = '22023', message = 'El pedido tiene demasiados productos';
  end if;

  if p_fulfillment is not null and p_fulfillment not in ('delivery', 'pickup', 'onsite') then
    raise exception using errcode = '22023', message = 'Tipo de entrega invalido';
  end if;

  if p_payment_method is not null and p_payment_method not in ('transferencia', 'efectivo') then
    raise exception using errcode = '22023', message = 'Metodo de pago invalido';
  end if;

  -- La dirección, si viene, debe ser de ESE cliente y ESE negocio.
  if p_address_id is not null then
    if not exists (
      select 1 from public.customer_addresses
      where id = p_address_id
        and business_id = p_business_id
        and customer_id = p_customer_id
        and active = true
    ) then
      raise exception using errcode = '42501', message = 'La direccion no pertenece a este cliente';
    end if;
  end if;

  insert into public.orders (
    business_id, customer_id, contact_phone, contact_name,
    subtotal, discount, total, status, source, address_id, fulfillment,
    payment_method
  ) values (
    p_business_id, p_customer_id, btrim(p_contact_phone), nullif(btrim(coalesce(p_contact_name, '')), ''),
    0, 0, 0, 'pendiente', 'storefront', p_address_id, p_fulfillment,
    p_payment_method
  )
  returning id into v_order_id;

  -- ── Cada línea, con su precio resuelto en la base ────────────────────────
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_count := v_count + 1;
    v_product_id := nullif(v_item ->> 'product_id', '')::uuid;
    v_variant_id := nullif(v_item ->> 'variant_id', '')::uuid;
    v_quantity := coalesce((v_item ->> 'quantity')::integer, 0);
    v_note := left(nullif(btrim(coalesce(v_item ->> 'note', '')), ''), 200);

    if v_quantity < 1 or v_quantity > 99 then
      raise exception using errcode = '22023', message = 'La cantidad debe estar entre 1 y 99';
    end if;

    select id, name, price, price_sale, stock
    into v_product
    from public.products
    where id = v_product_id
      and business_id = p_business_id
      and active = true
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'El producto no pertenece al negocio';
    end if;
    if v_product.stock = 'agotado' then
      raise exception using errcode = '22023', message = format('%s esta agotado', v_product.name);
    end if;

    -- El precio sale de la variante si la hay; si no, del producto.
    -- Se usa una bandera y no `v_variant is null`: en PL/pgSQL un record sin
    -- asignar no se puede consultar, ni siquiera para comprobar si es nulo.
    v_has_variant := v_variant_id is not null;
    if v_has_variant then
      select id, name, price, price_sale, stock
      into v_variant
      from public.product_variants
      where id = v_variant_id
        and product_id = v_product_id
        and business_id = p_business_id
        and active = true
      for share;
      if not found then
        raise exception using errcode = '42501', message = 'La variante no pertenece a este producto';
      end if;
      if v_variant.stock = 'agotado' then
        raise exception using errcode = '22023', message = format('%s (%s) esta agotado', v_product.name, v_variant.name);
      end if;
      v_variant_ref := v_variant.id;
      v_variant_label := v_variant.name;
      v_unit_price := round(
        case when v_variant.price_sale > 0 then v_variant.price_sale else v_variant.price end, 2
      );
    else
      v_variant_ref := null;
      v_variant_label := null;
      v_unit_price := round(
        case when v_product.price_sale > 0 then v_product.price_sale else v_product.price end, 2
      );
    end if;

    if not (v_unit_price > 0) then
      raise exception using errcode = '22023', message = format('%s no tiene un precio valido', v_product.name);
    end if;

    -- ── Extras: pertenencia comprobada, precio de la base ──────────────────
    v_extras_total := 0;
    v_extras_names := '{}'::text[];
    if jsonb_typeof(v_item -> 'extra_ids') = 'array' then
      if jsonb_array_length(v_item -> 'extra_ids') > 20 then
        raise exception using errcode = '22023', message = 'Demasiados extras en un producto';
      end if;
      select array_agg(value::uuid) into v_extra_ids
      from jsonb_array_elements_text(v_item -> 'extra_ids');

      if v_extra_ids is not null and cardinality(v_extra_ids) > 0 then
        select coalesce(sum(m.price_delta), 0), coalesce(array_agg(m.name order by m.name), '{}')
        into v_extras_total, v_extras_names
        from public.menu_modifiers m
        where m.id = any(v_extra_ids)
          and m.business_id = p_business_id
          and m.active = true
          -- Del producto, o de una etiqueta que ese producto tenga.
          and (
            m.product_id = v_product_id
            or (m.product_id is null and m.category_tag is not null and exists (
              select 1 from public.products p2
              where p2.id = v_product_id
                and lower(m.category_tag) = any(select lower(unnest(coalesce(p2.tags, '{}'))))
            ))
          );

        if coalesce(cardinality(v_extras_names), 0) <> cardinality(v_extra_ids) then
          raise exception using errcode = '42501', message = 'Algun extra no corresponde a este producto';
        end if;
      end if;
    end if;

    v_unit_price := round(v_unit_price + coalesce(v_extras_total, 0), 2);
    v_line_total := round(v_unit_price * v_quantity, 2);
    v_subtotal := v_subtotal + v_line_total;

    insert into public.order_items (
      order_id, business_id, product_id, product_name,
      variant_id, variant_name, extras_names, item_note,
      quantity, unit_price, line_total
    ) values (
      v_order_id, p_business_id, v_product.id, v_product.name,
      v_variant_ref, v_variant_label,
      coalesce(v_extras_names, '{}'), v_note,
      v_quantity, v_unit_price, v_line_total
    );
  end loop;

  -- ── El envío: fijo del negocio, y SOLO si se lleva a domicilio ───────────
  -- Quien retira en el local o consume en sitio no paga envío. El importe sale
  -- de la ficha del negocio, nunca del teléfono del cliente.
  v_subtotal := round(v_subtotal, 2);
  if p_fulfillment = 'delivery' then
    v_shipping := round(coalesce(v_business.delivery_fee, 0), 2);
  end if;

  update public.orders
  set subtotal = v_subtotal,
      shipping = v_shipping,
      total = round(v_subtotal + v_shipping, 2)
  where id = v_order_id;

  return jsonb_build_object(
    'id', v_order_id,
    'subtotal', v_subtotal,
    'shipping', v_shipping,
    'total', round(v_subtotal + v_shipping, 2),
    'items', v_count
  );
end;
$$;

revoke all on function public.create_storefront_order(
  uuid, uuid, text, text, uuid, text, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.create_storefront_order(
  uuid, uuid, text, text, uuid, text, jsonb, text, text
) to service_role;

-- ── 4. El comprobante de la transferencia ─────────────────────────────────
-- Lo sube el CLIENTE desde la mini app, que no tiene JWT: su credencial es el
-- enlace. Por eso la pertenencia se comprueba aquí con las tres cosas a la vez
-- —negocio, pedido y teléfono de la sesión—: sin esto, cualquiera con un id de
-- pedido ajeno podría colgarle una imagen.
create or replace function public.attach_storefront_payment_proof(
  p_business_id uuid,
  p_order_id uuid,
  p_contact_phone text,
  p_url text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
begin
  if nullif(btrim(coalesce(p_url, '')), '') is null or p_url !~ '^https://' then
    raise exception using errcode = '22023', message = 'El comprobante debe ser una URL https';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
    and business_id = p_business_id
    and contact_phone = btrim(p_contact_phone)
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- Un pedido ya cerrado no admite comprobante: o se pagó, o se anuló.
  if v_order.status in ('completado', 'cancelado', 'expirado') then
    return jsonb_build_object('result', 'invalid_state', 'status', v_order.status);
  end if;

  update public.orders
  set payment_proof_url = p_url, updated_at = now()
  where id = p_order_id and business_id = p_business_id;

  return jsonb_build_object('result', 'updated');
end;
$$;

revoke all on function public.attach_storefront_payment_proof(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.attach_storefront_payment_proof(uuid, uuid, text, text)
  to service_role;

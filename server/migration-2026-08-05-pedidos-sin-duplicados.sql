-- ============================================================================
-- UN DOBLE TOQUE YA NO CREA DOS PEDIDOS
--
-- Hoy, confirmar dos veces —o la app reintentando tras un corte de red— crea
-- dos pedidos idénticos: dos comandas en la cocina y un cliente que paga dos
-- veces. Es el fallo más caro que quedaba abierto en la tienda.
--
-- La app manda una CLAVE por intento de compra. Si ya existe un pedido con
-- ella, `create_storefront_order` devuelve ESE en vez de crear otro, con
-- `repetido: true` para que la app lo sepa. No es un error: es el mismo pedido.
--
-- ── Y dos cosas más que faltaban ────────────────────────────────────────────
--
-- `order_events`: el historial de estados. Sin él, «¿cuándo se confirmó?» solo
-- se responde mirando `updated_at`, que se pisa con cada cambio.
--
-- Cinco estados nuevos, en español como los siete que ya había:
--   esperando_pago      el cliente dijo transferencia y aún no sube nada
--   pago_en_revision    subió el comprobante y el dueño lo mira
--   aceptado            el dueño lo tomó, antes de ponerse a prepararlo
--   listo_para_retiro   el gemelo de `en_camino` para quien retira en local
--   rechazado           el comprobante no cuadra
--
-- Las transiciones se amplían en consecuencia. `completado`, `cancelado`,
-- `rechazado` y `expirado` siguen siendo finales: de ahí no se sale, así que
-- «cancelado → preparacion» queda fuera por no estar listado.
--
-- ⚠️ `create_storefront_order` cambia de FIRMA, así que se hace DROP de la
-- versión anterior. `create or replace` con un parámetro nuevo NO reemplaza:
-- crea una SEGUNDA función y las dos quedan vivas, con cualquier llamada
-- vuelta ambigua. Lo vigila `verificar-esquema.sql`.
--
-- Idempotente. Aditiva. Sin pérdida de datos.
-- ============================================================================

-- ── 1. La clave del pedido y su programación ────────────────────────────────
alter table public.orders
  add column if not exists idempotency_key text;
alter table public.orders
  add column if not exists scheduled_for timestamptz;

-- Único POR NEGOCIO y solo cuando hay clave: los pedidos del bot no la traen y
-- no pueden chocar entre sí por ser todos nulos.
create unique index if not exists uq_orders_idempotencia
  on public.orders (business_id, idempotency_key)
  where idempotency_key is not null;

-- ── 2. Los estados nuevos ───────────────────────────────────────────────────
do $$
begin
  alter table public.orders drop constraint if exists orders_status_check;
  alter table public.orders add constraint orders_status_check check (status in (
    'pendiente', 'esperando_pago', 'pago_en_revision', 'confirmado', 'aceptado',
    'preparacion', 'listo_para_retiro', 'en_camino', 'completado',
    'cancelado', 'rechazado', 'expirado'
  ));
end $$;

-- ── 3. El historial ─────────────────────────────────────────────────────────
create table if not exists public.order_events (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  order_id    uuid not null,
  from_status text,
  to_status   text not null,
  note        text,
  created_at  timestamptz not null default now(),
  constraint order_events_datos_check check (
    char_length(btrim(to_status)) between 1 and 40
    and char_length(coalesce(note, '')) <= 300
  )
);

-- El pedido se referencia por PAREJA: sin el business_id dentro, se podría
-- colgar el historial de un negocio sobre el pedido de otro.
create unique index if not exists uq_orders_id_business
  on public.orders (id, business_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_events'::regclass
      and conname = 'fk_order_events_pedido_del_negocio'
  ) then
    alter table public.order_events
      add constraint fk_order_events_pedido_del_negocio
      foreign key (order_id, business_id)
      references public.orders (id, business_id) on delete cascade;
  end if;
end $$;

create index if not exists idx_order_events_pedido
  on public.order_events (business_id, order_id, created_at);

alter table public.order_events enable row level security;
revoke all on table public.order_events from public, anon, authenticated;
grant select, insert, update, delete on table public.order_events to service_role;

-- ── 4. Las funciones ────────────────────────────────────────────────────────
drop function if exists public.create_storefront_order(
  uuid, uuid, text, text, uuid, text, jsonb, text, text
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
  p_payment_method text default null,
  p_idempotency_key text default null,
  p_scheduled_for timestamptz default null
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
  -- Lo elegido de los grupos de opciones, ya validado y con su precio de la
  -- base. Se acumula EN MEMORIA y por línea: una tabla auxiliar la pisarían
  -- dos pedidos simultáneos del mismo negocio.
  v_chosen jsonb;
  v_option jsonb;
  v_option_row record;
  v_options_total numeric(10,2);
  v_options_names text[];
  v_option_qty integer;
  v_group record;
  v_group_count integer;
  v_grupo_total numeric(10,2);
  v_product_category uuid;
  v_order_item_id uuid;
  v_unit_price numeric(10,2);
  v_line_total numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_shipping numeric(10,2) := 0;
  v_count integer := 0;
  v_clave text;
  v_existente public.orders%rowtype;
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

  -- ── El mismo pedido dos veces es UN pedido ──────────────────────────────
  --
  -- Un doble toque en «Confirmar», o la app reintentando tras un corte de red,
  -- creaban dos pedidos idénticos: dos comandas en la cocina y un cliente que
  -- paga dos veces. La app manda una clave por intento de compra; si ya existe
  -- un pedido con ella, se DEVUELVE ese en vez de crear otro.
  v_clave := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_clave is not null then
    if char_length(v_clave) > 100 then
      raise exception using errcode = '22023', message = 'Clave de pedido invalida';
    end if;
    select * into v_existente
    from public.orders
    where business_id = p_business_id and idempotency_key = v_clave;
    if found then
      return jsonb_build_object(
        'id', v_existente.id,
        'subtotal', v_existente.subtotal,
        'shipping', v_existente.shipping,
        'total', v_existente.total,
        'items', (select count(*) from public.order_items oi where oi.order_id = v_existente.id),
        'repetido', true
      );
    end if;
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
    payment_method, idempotency_key, scheduled_for
  ) values (
    p_business_id, p_customer_id, btrim(p_contact_phone), nullif(btrim(coalesce(p_contact_name, '')), ''),
    0, 0, 0, 'pendiente', 'storefront', p_address_id, p_fulfillment,
    p_payment_method, v_clave, p_scheduled_for
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

    select id, name, price, price_sale, stock, category_id
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

    -- ── Grupos de opciones: el motor con el que se arma un plato ──────────
    --
    -- Aquí se decide el dinero de verdad. La app manda id y cantidad; el
    -- recargo, el nombre y el derecho a estar en este producto salen de la
    -- base (regla inviolable #8).
    v_options_total := 0;
    v_options_names := '{}'::text[];
    v_chosen := '[]'::jsonb;
    v_product_category := v_product.category_id;

    if jsonb_typeof(v_item -> 'options') = 'array' then
      if jsonb_array_length(v_item -> 'options') > 30 then
        raise exception using errcode = '22023', message = 'Demasiadas opciones en un producto';
      end if;

      for v_option in select * from jsonb_array_elements(v_item -> 'options')
      loop
        v_option_qty := greatest(1, least(100, coalesce((v_option ->> 'quantity')::integer, 1)));

        -- La opción tiene que ser de este negocio Y de un grupo que aplique a
        -- ESTE producto: del producto, o de su categoría. Sin esto se podría
        -- abaratar una pizza mandando el id de una opción de otro plato.
        select o.id, o.name, o.price_adjustment, o.stock,
               og.id as group_id, og.name as group_name, og.selection_type
        into v_option_row
        from public.options o
        join public.option_groups og on og.id = o.option_group_id
        where o.id = nullif(v_option ->> 'option_id', '')::uuid
          and o.business_id = p_business_id
          and o.active = true
          and og.business_id = p_business_id
          and og.active = true
          and (
            og.product_id = v_product_id
            or (og.category_id is not null and og.category_id = v_product_category)
          );
        if not found then
          raise exception using errcode = '42501',
            message = format('Una opcion no corresponde a %s', v_product.name);
        end if;
        if v_option_row.stock = 'agotado' then
          raise exception using errcode = '22023',
            message = format('%s ya no esta disponible', v_option_row.name);
        end if;

        -- Fuera de los contadores, pedir tres veces la misma opción no
        -- significa nada y multiplicaría su recargo.
        if v_option_row.selection_type <> 'quantity' and v_option_qty <> 1 then
          raise exception using errcode = '22023',
            message = format('%s no se elige por cantidad', v_option_row.group_name);
        end if;
        -- Ni mandarla dos veces, que sería el mismo truco por otra puerta.
        if exists (
          select 1 from jsonb_array_elements(v_chosen) e
          where (e ->> 'option_id')::uuid = v_option_row.id
        ) then
          raise exception using errcode = '22023',
            message = format('%s viene repetida', v_option_row.name);
        end if;

        -- El importe ya NO se suma aquí: cada grupo se cobra según SU
        -- estrategia, y para eso hace falta ver todo lo elegido junto.
        v_options_names := v_options_names || (
          case when v_option_qty > 1
            then format('%s x%s', v_option_row.name, v_option_qty)
            else v_option_row.name
          end
        );
        v_chosen := v_chosen || jsonb_build_object(
          'option_id', v_option_row.id,
          'option_group_id', v_option_row.group_id,
          'option_group_name', v_option_row.group_name,
          'option_name', v_option_row.name,
          'quantity', v_option_qty,
          'unit_price_adjustment', v_option_row.price_adjustment
        );
      end loop;
    end if;

    -- ── Lo OBLIGATORIO se comprueba aquí, no en el navegador ──────────────
    --
    -- Un pedido sin el término de la carne llega a la cocina sin poder
    -- prepararse. La app ya lo impide, pero la app se puede saltar: esto es
    -- lo único que de verdad manda.
    for v_group in
      select og.id, og.name, og.selection_type, og.required,
             og.min_selectable, og.max_selectable,
             og.pricing_strategy, og.free_selections
      from public.option_groups og
      where og.business_id = p_business_id
        and og.active = true
        and (
          og.product_id = v_product_id
          or (og.category_id is not null and og.category_id = v_product_category)
        )
    loop
      -- En los contadores cuentan las PORCIONES; en el resto, cuántas se
      -- marcaron. Una parrillada de 4 se cumple con un corte pedido 4 veces.
      select coalesce(sum(
        case when v_group.selection_type = 'quantity'
          then (e ->> 'quantity')::integer else 1 end
      ), 0)
      into v_group_count
      from jsonb_array_elements(v_chosen) e
      where (e ->> 'option_group_id')::uuid = v_group.id;

      -- ── Lo que suma ESTE grupo, según cómo lo cobre el negocio ────────
      --
      -- Aquí vive la pizza mitad y mitad. Con `sum`, media Suprema ($10) y
      -- media Hawaiana ($9) costarían $19 —el doble de una pizza—; con
      -- `highest_selected` se cobra $10, que es como lo cobra el negocio.
      --
      -- Las estrategias con límite descuentan siempre las opciones MÁS CARAS,
      -- y nunca por orden de llegada: el mismo carrito tiene que costar lo
      -- mismo aunque se arme al revés.
      v_grupo_total := 0;
      if v_group_count > 0 then
        case coalesce(v_group.pricing_strategy, 'sum')
          when 'fixed' then v_grupo_total := 0;
          when 'included' then v_grupo_total := 0;
          when 'highest_selected' then
            -- El precio UNITARIO, sin multiplicar: dos medias pizzas son una.
            select max((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'lowest_selected' then
            select min((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'average' then
            select avg((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'included_up_to_limit' then
            -- Las N más caras van incluidas; el resto suma entero.
            select coalesce(sum(precio * cantidad), 0) into v_grupo_total
            from (
              select (e ->> 'unit_price_adjustment')::numeric as precio,
                     (e ->> 'quantity')::integer as cantidad,
                     row_number() over (
                       order by (e ->> 'unit_price_adjustment')::numeric desc
                     ) as puesto
              from jsonb_array_elements(v_chosen) e
              where (e ->> 'option_group_id')::uuid = v_group.id
            ) ordenadas
            where puesto > coalesce(v_group.free_selections, 0);
          when 'extra_after_limit' then
            -- Igual, pero el cupo se gasta en PORCIONES: una opción puede
            -- quedar a medias —dos bolas incluidas y la tercera cobrada—.
            select coalesce(sum(precio * greatest(0, cantidad - gratis)), 0)
            into v_grupo_total
            from (
              select precio, cantidad,
                     greatest(0, least(
                       cantidad,
                       coalesce(v_group.free_selections, 0) - coalesce(previas, 0)
                     )) as gratis
              from (
                select (e ->> 'unit_price_adjustment')::numeric as precio,
                       (e ->> 'quantity')::integer as cantidad,
                       sum((e ->> 'quantity')::integer) over (
                         order by (e ->> 'unit_price_adjustment')::numeric desc
                         rows between unbounded preceding and 1 preceding
                       ) as previas
                from jsonb_array_elements(v_chosen) e
                where (e ->> 'option_group_id')::uuid = v_group.id
              ) con_previas
            ) repartido;
          else
            -- `sum`: cada opción suma su recargo por sus porciones.
            select coalesce(sum(
              (e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer
            ), 0) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
        end case;
        v_options_total := v_options_total + round(coalesce(v_grupo_total, 0), 2);
      end if;

      if v_group_count < greatest(
        case when v_group.required then 1 else 0 end,
        coalesce(v_group.min_selectable, 0)
      ) then
        raise exception using errcode = '22023',
          message = format('Falta elegir %s en %s', v_group.name, v_product.name);
      end if;
      if v_group_count > coalesce(v_group.max_selectable, 1) then
        raise exception using errcode = '22023',
          message = format('Demasiadas opciones en %s', v_group.name);
      end if;
    end loop;

    -- Los recargos pueden ser NEGATIVOS («sin sopa −0.50»). Acumulados podrían
    -- dejar la línea en cero o por debajo, que es un plato regalado.
    v_unit_price := round(
      v_unit_price + coalesce(v_extras_total, 0) + coalesce(v_options_total, 0), 2
    );
    if not (v_unit_price > 0) then
      raise exception using errcode = '22023',
        message = format('%s quedaria sin precio valido con esas opciones', v_product.name);
    end if;

    v_line_total := round(v_unit_price * v_quantity, 2);
    v_subtotal := v_subtotal + v_line_total;

    -- `extras_names` es lo que el DUEÑO ve en su panel de pedidos. Las opciones
    -- entran ahí ADEMÁS de en `order_item_options`: si solo fueran a la tabla
    -- nueva, el pedido se vería sin lo que el cliente pidió.
    insert into public.order_items (
      order_id, business_id, product_id, product_name,
      variant_id, variant_name, extras_names, item_note,
      quantity, unit_price, line_total
    ) values (
      v_order_id, p_business_id, v_product.id, v_product.name,
      v_variant_ref, v_variant_label,
      coalesce(v_extras_names, '{}') || coalesce(v_options_names, '{}'), v_note,
      v_quantity, v_unit_price, v_line_total
    )
    returning id into v_order_item_id;

    -- La fotografía inmutable de lo elegido, con su precio congelado: si
    -- mañana cambia el recargo, el pedido de ayer sigue diciendo lo que costó.
    insert into public.order_item_options (
      business_id, order_item_id, option_group_id, option_id,
      option_group_name, option_name, quantity,
      unit_price_adjustment, total_price_adjustment
    )
    select p_business_id, v_order_item_id,
           (e ->> 'option_group_id')::uuid, (e ->> 'option_id')::uuid,
           e ->> 'option_group_name', e ->> 'option_name',
           (e ->> 'quantity')::integer,
           (e ->> 'unit_price_adjustment')::numeric,
           round((e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer, 2)
    from jsonb_array_elements(v_chosen) e;
  end loop;

  -- ── El envío: fijo del negocio, y SOLO si se lleva a domicilio ───────────
  -- Quien retira en el local no paga envío. El importe sale de la ficha del
  -- negocio, nunca del teléfono del cliente (regla inviolable #8).
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

create or replace function public.set_order_status(
  p_business_id uuid,
  p_order_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_anterior text;
begin
  if p_status not in (
    'pendiente', 'esperando_pago', 'pago_en_revision', 'confirmado', 'aceptado',
    'preparacion', 'listo_para_retiro', 'en_camino', 'completado',
    'cancelado', 'rechazado', 'expirado'
  ) then
    raise exception using errcode = '22023', message = 'Estado de pedido inválido';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id and business_id = p_business_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found', 'order', null);
  end if;

  if v_order.status = p_status then
    return jsonb_build_object('result', 'updated', 'order', to_jsonb(v_order));
  end if;
  v_anterior := v_order.status;

  -- Un pedido que el cliente retira en el local (o consume en sitio) no puede
  -- salir a reparto. Los pedidos del bot no traen `fulfillment`: se asumen a
  -- domicilio, que es como funcionan hoy por WhatsApp.
  if p_status = 'en_camino'
     and coalesce(v_order.fulfillment, 'delivery') <> 'delivery' then
    return jsonb_build_object('result', 'not_deliverable', 'order', to_jsonb(v_order));
  end if;

  -- Y al revés: un pedido a domicilio no se queda «listo para retirar».
  if p_status = 'listo_para_retiro'
     and coalesce(v_order.fulfillment, 'delivery') = 'delivery' then
    return jsonb_build_object('result', 'not_pickable', 'order', to_jsonb(v_order));
  end if;

  -- El pedido avanza; nunca retrocede. `completado`, `cancelado`, `rechazado`
  -- y `expirado` son finales: de ahí no sale a ningún sitio, así que
  -- «cancelado → preparacion» o «completado → preparacion» quedan fuera por no
  -- estar listados, no por una regla aparte.
  if not (
    (v_order.status = 'pendiente'
      and p_status in ('esperando_pago', 'pago_en_revision', 'confirmado', 'aceptado',
                       'preparacion', 'cancelado', 'rechazado', 'expirado'))
    or (v_order.status = 'esperando_pago'
      and p_status in ('pago_en_revision', 'confirmado', 'cancelado', 'expirado'))
    -- El comprobante está subido y el dueño lo revisa: de aquí sale aceptado o
    -- rechazado, nunca directo a la cocina.
    or (v_order.status = 'pago_en_revision'
      and p_status in ('confirmado', 'aceptado', 'rechazado', 'cancelado', 'expirado'))
    or (v_order.status = 'confirmado'
      and p_status in ('aceptado', 'preparacion', 'listo_para_retiro', 'en_camino',
                       'completado', 'cancelado', 'expirado'))
    or (v_order.status = 'aceptado'
      and p_status in ('preparacion', 'listo_para_retiro', 'en_camino', 'completado',
                       'cancelado'))
    or (v_order.status = 'preparacion'
      and p_status in ('listo_para_retiro', 'en_camino', 'completado', 'cancelado'))
    or (v_order.status = 'listo_para_retiro'
      and p_status in ('completado', 'cancelado'))
    or (v_order.status = 'en_camino'
      and p_status in ('completado', 'cancelado'))
  ) then
    return jsonb_build_object('result', 'invalid_transition', 'order', to_jsonb(v_order));
  end if;

  update public.orders
  set status = p_status, updated_at = now()
  where id = p_order_id and business_id = p_business_id
  returning * into v_order;

  -- El historial. Sin esto, «¿cuándo se confirmó?» solo se puede responder
  -- mirando `updated_at`, que se pisa con cada cambio.
  insert into public.order_events (business_id, order_id, from_status, to_status)
  values (p_business_id, p_order_id, v_anterior, p_status);

  -- Entregado = vendido. Si algo fallara aquí cae la transacción entera: nunca
  -- queda un pedido entregado sin su venta.
  if p_status = 'completado' then
    perform public.crear_venta_desde_pedido(p_business_id, p_order_id);
  end if;

  return jsonb_build_object('result', 'updated', 'order', to_jsonb(v_order));
end;
$$;

revoke all on function public.create_storefront_order(
  uuid, uuid, text, text, uuid, text, jsonb, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.create_storefront_order(
  uuid, uuid, text, text, uuid, text, jsonb, text, text, text, timestamptz
) to service_role;

-- ── Comprobación inmediata ──────────────────────────────────────────────────
do $comprobacion$
declare
  v_biz uuid; v_prod uuid; v_a jsonb; v_b jsonb;
begin
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders, storefront_enabled)
  values ('idem-a', 'Idem', 'pizzería', 'ycloud', '+593900999801', '+593900999801', true, true)
  returning id into v_biz;
  insert into products (business_id, name, price, stock, active)
  values (v_biz, 'Pizza', 10, 'disponible', true) returning id into v_prod;

  -- Dos veces la MISMA clave: un solo pedido.
  v_a := public.create_storefront_order(
    v_biz, null, '+593900000002', 'Cliente', null, 'pickup',
    jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1)),
    null, null, 'clave-del-cliente'
  );
  v_b := public.create_storefront_order(
    v_biz, null, '+593900000002', 'Cliente', null, 'pickup',
    jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1)),
    null, null, 'clave-del-cliente'
  );
  if (v_a ->> 'id') <> (v_b ->> 'id') then
    raise exception 'La misma clave creó DOS pedidos';
  end if;
  if (v_b ->> 'repetido')::boolean is not true then
    raise exception 'El segundo intento no se marcó como repetido';
  end if;
  if (select count(*) from orders where business_id = v_biz) <> 1 then
    raise exception 'Quedó más de un pedido con la misma clave';
  end if;

  -- Sin clave se siguen creando pedidos distintos: el bot no la manda.
  v_b := public.create_storefront_order(
    v_biz, null, '+593900000002', 'Cliente', null, 'pickup',
    jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1))
  );
  if (v_a ->> 'id') = (v_b ->> 'id') then
    raise exception 'Sin clave se reutilizó un pedido anterior';
  end if;

  -- El historial se escribe en cada cambio.
  perform public.set_order_status(v_biz, (v_a ->> 'id')::uuid, 'confirmado');
  perform public.set_order_status(v_biz, (v_a ->> 'id')::uuid, 'preparacion');
  if (select count(*) from order_events where order_id = (v_a ->> 'id')::uuid) <> 2 then
    raise exception 'El historial no registró los dos cambios';
  end if;
  if not exists (
    select 1 from order_events
    where order_id = (v_a ->> 'id')::uuid
      and from_status = 'confirmado' and to_status = 'preparacion'
  ) then
    raise exception 'El historial no guardó de dónde venía el pedido';
  end if;

  -- Un pedido de retiro no sale a reparto…
  if (public.set_order_status(v_biz, (v_a ->> 'id')::uuid, 'en_camino') ->> 'result')
     <> 'not_deliverable' then
    raise exception 'Un pedido de retiro salió a reparto';
  end if;
  -- …y sí puede quedar listo para retirar.
  if (public.set_order_status(v_biz, (v_a ->> 'id')::uuid, 'listo_para_retiro') ->> 'result')
     <> 'updated' then
    raise exception 'Un pedido de retiro no pudo quedar listo';
  end if;

  -- Y de un estado FINAL no se vuelve atrás.
  perform public.set_order_status(v_biz, (v_a ->> 'id')::uuid, 'cancelado');
  if (public.set_order_status(v_biz, (v_a ->> 'id')::uuid, 'preparacion') ->> 'result')
     <> 'invalid_transition' then
    raise exception 'Un pedido cancelado volvió a preparación';
  end if;

  delete from businesses where id = v_biz;
  raise notice 'PEDIDOS: clave idempotente, historial y estados nuevos comprobados';
end;
$comprobacion$;

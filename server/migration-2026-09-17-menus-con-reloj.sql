-- ═══════════════════════════════════════════════════════════════════════════
-- MENÚS CON RELOJ: UN PRODUCTO SE PIDE EN SU FRANJA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Pedido del dueño (2026-09-17): «hay restaurantes que ofrecen almuerzos y
-- otros que ofrecen desde el desayuno, almuerzo y meriendas; ¿cómo lo hacen
-- las apps grandes?».
--
-- Lo hacen así: el local NO cambia con la hora, cambia su CARTA. Un solo
-- restaurante con «desayuno 07:00–11:00», «almuerzo 11:30–15:00» y «carta de
-- noche 18:00–02:00». El cliente que entra a las 8 de la mañana ve desayunos.
--
-- ⚠️ LA MITAD ESTABA CONSTRUIDA Y DESCONECTADA. `products.available_days`,
-- `available_from` y `available_until` existen desde hace meses, con su CHECK
-- validando días y rangos… y no las leía NADIE: ni la tienda, ni la
-- cotización, ni esta función, ni el panel del dueño. Duodécima vez del patrón
-- de camino-real.
--
-- ⚠️ EL FRENO VA EN LA BASE, no solo en la tienda. Es camino del dinero: un
-- carrito armado en el navegador con un producto fuera de su franja lo
-- rechaza `create_storefront_order`, igual que un agotado o un precio
-- inventado. La tienda además lo pinta apagado, que es la mitad amable.
--
-- ⚠️ La hora es la de ECUADOR, la misma que manda en el horario del local
-- (`services/schedule.ts` y las demás funciones de esta base).
--
-- Lo que NO toca: los productos existentes (sin franja = sin límite, que es
-- como han vivido todos), los precios, ni el resto de la RPC del pedido. Su
-- firma no cambia: un parámetro nuevo crearía una segunda versión viva.


-- ── 1. La regla, en un solo sitio ──────────────────────────────────────────
--
-- Nula por completo = se pide siempre. Es el caso de todos los productos de
-- hoy y no puede costarles nada.
create or replace function public.producto_en_horario(
  p_days  smallint[],
  p_from  time,
  p_until time,
  p_ahora timestamptz default now()
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  with local as (
    select timezone('America/Guayaquil', p_ahora) as ahora
  ),
  momento as (
    select
      ahora::time as hora,
      extract(dow from ahora)::smallint as dia,
      -- ⚠️ La franja que CRUZA MEDIANOCHE pertenece al día que EMPEZÓ: a la
      -- 01:00 del martes, la carta «de lunes por la noche» sigue siendo del
      -- lunes. Sin esto, un local que cierra a las 02:00 perdía sus dos
      -- últimas horas de venta cada noche — y el fallo solo se vería de
      -- madrugada, que es cuando nadie mira.
      (extract(dow from ahora)::smallint + 6) % 7 as dia_anterior,
      p_from is not null and p_until is not null and p_from > p_until as cruza
    from local
  )
  select
    -- El día: sin lista, todos.
    (
      p_days is null
      or array_length(p_days, 1) is null
      or (case
            when momento.cruza and momento.hora <= p_until then momento.dia_anterior
            else momento.dia
          end) = any(p_days)
    )
    -- Y la hora: sin franja, todo el día.
    and (
      p_from is null or p_until is null
      or (case
            when momento.cruza then momento.hora >= p_from or momento.hora <= p_until
            else momento.hora between p_from and p_until
          end)
    )
  from momento;
$$;

comment on function public.producto_en_horario(smallint[], time, time, timestamptz) is
  'Si un producto con esta franja se puede pedir en ese momento, en hora de Ecuador.';

revoke all on function public.producto_en_horario(smallint[], time, time, timestamptz)
  from public, anon, authenticated;
grant execute on function public.producto_en_horario(smallint[], time, time, timestamptz)
  to service_role;


-- ── 2. El pedido lo exige ──────────────────────────────────────────────────
--
-- ⚠️ Solo cambian DOS cosas dentro de `create_storefront_order`: el `select`
-- del producto trae sus tres columnas de franja, y debajo del freno de
-- «agotado» va el de la hora. Todo lo demás queda intacto, y por eso el parche
-- se aplica sobre el cuerpo vivo en vez de reescribir la función entera: es la
-- puerta única del dinero y no se reescribe para añadir una comprobación.
do $$
declare
  v_cuerpo text;
  v_viejo  text := '    select id, name, price, price_sale, stock, category_id
    into v_product';
  v_nuevo  text := '    select id, name, price, price_sale, stock, category_id,
           available_days, available_from, available_until
    into v_product';
  v_viejo2 text := '    if v_product.stock = ''agotado'' then
      raise exception using errcode = ''22023'', message = format(''%s esta agotado'', v_product.name);
    end if;';
  v_nuevo2 text := '    if v_product.stock = ''agotado'' then
      raise exception using errcode = ''22023'', message = format(''%s esta agotado'', v_product.name);
    end if;
    -- Menús con reloj (2026-09-17): fuera de su franja no se vende, lo pinte
    -- como lo pinte el teléfono.
    if not public.producto_en_horario(
         v_product.available_days, v_product.available_from, v_product.available_until
       ) then
      raise exception using errcode = ''22023'',
        message = format(''%s no se puede pedir a esta hora'', v_product.name);
    end if;';
begin
  select prosrc into v_cuerpo
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'create_storefront_order';

  if v_cuerpo is null then
    raise exception 'no existe create_storefront_order: nada que parchear';
  end if;
  -- Repetible: si el freno ya está puesto, no se toca nada. Estas migraciones
  -- se aplican a mano y volver a correrlas no puede romper la puerta del
  -- dinero.
  if position('no se puede pedir a esta hora' in v_cuerpo) > 0 then
    raise notice 'create_storefront_order ya exige la franja del producto';
    return;
  end if;
  if position(v_viejo in v_cuerpo) = 0 or position(v_viejo2 in v_cuerpo) = 0 then
    raise exception 'create_storefront_order no tiene la forma esperada: revísala a mano';
  end if;

  v_cuerpo := replace(replace(v_cuerpo, v_viejo, v_nuevo), v_viejo2, v_nuevo2);

  execute format(
    'create or replace function public.create_storefront_order(
       p_business_id uuid, p_customer_id uuid, p_contact_phone text,
       p_contact_name text, p_address_id uuid, p_fulfillment text,
       p_items jsonb, p_notes text default null, p_payment_method text default null,
       p_idempotency_key text default null, p_scheduled_for timestamptz default null
     ) returns jsonb language plpgsql security definer
       set search_path = public, pg_temp as %L', v_cuerpo);
end;
$$;

revoke all on function public.create_storefront_order(
  uuid, uuid, text, text, uuid, text, jsonb, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.create_storefront_order(
  uuid, uuid, text, text, uuid, text, jsonb, text, text, text, timestamptz
) to service_role;

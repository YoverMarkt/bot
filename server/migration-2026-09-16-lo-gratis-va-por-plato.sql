-- ═══════════════════════════════════════════════════════════════════════════
-- LO QUE VA GRATIS, VA POR PLATO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Lo encontró el dueño mirando su propio local (2026-09-16): «el jugo o bebida
-- que va gratis es por el número de almuerzos que lleva el cliente, pero ahora
-- está que pueden elegir muchos jugos gratis».
--
-- Y era cierto en las TRES capas que arman un plato por partes —la app
-- (`cart.ts`), el servidor (`pricing.ts`) y esta función—: ninguna contaba
-- cuántos platos llevaba el cliente. Sopa y Segundo sí se topan, porque son
-- `is_meal_part` y el plato se cuenta por la parte más corta; la bebida NO es
-- parte, así que caía en «acompañantes gratis» sin ningún límite.
--
-- ⚠️ El único freno era `max_selectable` del grupo, y en La Abuelita valía
-- **100**: un almuerzo de $3.50 se podía llevar cien jugos. A $0.60 el jugo son
-- $60 de pérdida en un pedido de $3.50.
--
-- LA REGLA, con las palabras del dueño: «si son 2 almuerzos completos, 2 jugos
-- nada más; si son 2 almuerzos y un segundo, 3 jugos». O sea:
--
--     platos = platos completos + partes sueltas
--
-- que es EXACTAMENTE la cuenta que esta función ya hacía para partir las
-- líneas del pedido. No había que inventar nada: había que conectarla.
--
-- ⚠️ Solo topa lo GRATIS. Un adicional con precio no tiene límite y no debe
-- tenerlo: quien quiera cinco porciones de carne las paga, y cada una suma.
--
-- ⚠️ Se recrea SOLO `lineas_del_plato_por_partes`. `create_storefront_order`
-- no se toca: la llama y hereda el freno.
--
-- Lo que NO toca: precios, márgenes, stock, el resto del catálogo ni los
-- pedidos ya hechos.
create or replace function public.lineas_del_plato_por_partes(
  p_business_id uuid,
  p_product_id uuid,
  p_product_name text,
  p_precio numeric,
  p_elegidas jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_completos integer;
  v_hay_partes boolean;
  v_parte record;
  v_eleccion record;
  v_sobran integer;
  v_para_completar integer;
  v_toma integer;
  v_del_completo jsonb := '[]'::jsonb;
  v_sueltas jsonb := '[]'::jsonb;
  v_opciones_sueltas jsonb;
  v_sueltos_total integer := 0;
  v_platos integer;
  v_grupo_pasado text;
  v_marcadas integer;
  v_gratis jsonb := '[]'::jsonb;
  v_con_precio jsonb := '[]'::jsonb;
  v_lineas jsonb := '[]'::jsonb;
begin
  -- Tantos platos completos como porciones tenga la parte MÁS CORTA. Cuentan
  -- las partes activas que tienen algo que se pueda pedir hoy.
  with porciones as (
    select (e ->> 'option_group_id')::uuid as grupo,
           sum((e ->> 'quantity')::integer) as total
    from jsonb_array_elements(p_elegidas) e
    group by 1
  )
  select coalesce(min(coalesce(p.total, 0)), 0)::integer,
         coalesce(bool_or(coalesce(p.total, 0) > 0), false)
  into v_completos, v_hay_partes
  from public.option_groups og
  left join porciones p on p.grupo = og.id
  where og.business_id = p_business_id
    and og.product_id = p_product_id
    and og.active = true
    and og.is_meal_part = true
    and exists (
      select 1 from public.options o
      where o.option_group_id = og.id
        and o.business_id = p_business_id
        and o.active = true
        and o.stock <> 'agotado'
    );

  if not v_hay_partes then
    raise exception using errcode = '22023',
      message = format('Elige qué quieres en %s', p_product_name);
  end if;
  if v_completos > 99 then
    raise exception using errcode = '22023', message = 'La cantidad debe estar entre 1 y 99';
  end if;

  for v_parte in
    select og.id, og.name, og.loose_price,
           coalesce((
             select sum((e ->> 'quantity')::integer)
             from jsonb_array_elements(p_elegidas) e
             where (e ->> 'option_group_id')::uuid = og.id
           ), 0)::integer as total
    from public.option_groups og
    where og.business_id = p_business_id
      and og.product_id = p_product_id
      and og.active = true
      and og.is_meal_part = true
      and exists (
        select 1 from public.options o
        where o.option_group_id = og.id
          and o.business_id = p_business_id
          and o.active = true
          and o.stock <> 'agotado'
      )
    order by og.sort, og.id
  loop
    v_sobran := v_parte.total - v_completos;
    if v_sobran > 0 and v_parte.loose_price is null then
      raise exception using errcode = '22023',
        message = format(
          'En %s no se vende %s por separado: completa el plato',
          p_product_name, lower(v_parte.name)
        );
    end if;
    if v_sobran > 99 then
      raise exception using errcode = '22023', message = 'La cantidad debe estar entre 1 y 99';
    end if;

    -- Las porciones llenan primero los platos completos siguiendo la carta del
    -- dueño; las que sobran son las ÚLTIMAS. No cambia un centavo, pero así la
    -- comanda sale igual se marque en el orden que se marque.
    v_para_completar := v_completos;
    v_opciones_sueltas := '[]'::jsonb;
    for v_eleccion in
      select e as dato, (e ->> 'quantity')::integer as cantidad
      from jsonb_array_elements(p_elegidas) e
      join public.options o on o.id = (e ->> 'option_id')::uuid
      where (e ->> 'option_group_id')::uuid = v_parte.id
        and (e ->> 'quantity')::integer > 0
      order by o.sort, o.id
    loop
      v_toma := least(v_eleccion.cantidad, v_para_completar);
      v_para_completar := v_para_completar - v_toma;
      -- Una porción de una parte no tiene recargo: dentro del plato vale lo que
      -- dice el plato, y suelta, lo que dice su grupo.
      if v_toma > 0 then
        v_del_completo := v_del_completo || jsonb_build_array(
          v_eleccion.dato || jsonb_build_object('quantity', v_toma, 'unit_price_adjustment', 0)
        );
      end if;
      if v_eleccion.cantidad - v_toma > 0 then
        v_opciones_sueltas := v_opciones_sueltas || jsonb_build_array(
          v_eleccion.dato || jsonb_build_object(
            'quantity', v_eleccion.cantidad - v_toma, 'unit_price_adjustment', 0
          )
        );
      end if;
    end loop;

    if v_sobran > 0 then
      v_sueltos_total := v_sueltos_total + v_sobran;
      v_sueltas := v_sueltas || jsonb_build_array(jsonb_build_object(
        'name', 'Solo ' || lower(v_parte.name),
        'quantity', v_sobran,
        'unit_price', round(v_parte.loose_price, 2),
        'options', v_opciones_sueltas
      ));
    end if;
  end loop;

  -- ── LO GRATIS VA POR PLATO ───────────────────────────────────────────────
  --
  -- Un plato completo o una parte suelta llevan cada uno lo suyo: 2 almuerzos
  -- y un segundo suelto son TRES platos y tres jugos.
  --
  -- ⚠️ Añadido el 2026-09-16, y hasta entonces no lo contaba NADIE: ni la app,
  -- ni `pricing.ts`, ni esta función. El único tope era `max_selectable` del
  -- grupo, que en un local real valía 100 — un almuerzo de $3.50 se llevaba
  -- cien jugos gratis. Lo vio el dueño, no una prueba.
  --
  -- ⚠️ Solo topa lo GRATIS. Quien quiera cinco porciones de carne las paga, y
  -- ahí no hay nada que proteger: cada una suma a su precio.
  v_platos := v_completos + v_sueltos_total;

  select og.name, sum((e ->> 'quantity')::integer)
    into v_grupo_pasado, v_marcadas
    from jsonb_array_elements(p_elegidas) e
    join public.option_groups og on og.id = (e ->> 'option_group_id')::uuid
   where og.is_meal_part = false
     and coalesce((e ->> 'unit_price_adjustment')::numeric, 0) = 0
     and (e ->> 'quantity')::integer > 0
   group by og.id, og.name, og.sort
  having sum((e ->> 'quantity')::integer) > v_platos
   order by og.sort, og.id
   limit 1;

  if v_grupo_pasado is not null then
    raise exception using errcode = '22023',
      message = format(
        'En %s, %s va con cada plato: llevas %s y marcaste %s',
        p_product_name, lower(v_grupo_pasado), v_platos, v_marcadas
      );
  end if;

  -- ── Lo que acompaña: gratis con el plato, o su propia línea ───────────────
  for v_eleccion in
    select e as dato,
           (e ->> 'quantity')::integer as cantidad,
           (e ->> 'unit_price_adjustment')::numeric as precio,
           e ->> 'option_name' as nombre
    from jsonb_array_elements(p_elegidas) e
    join public.option_groups og on og.id = (e ->> 'option_group_id')::uuid
    join public.options o on o.id = (e ->> 'option_id')::uuid
    where og.is_meal_part = false
      and (e ->> 'quantity')::integer > 0
    order by og.sort, og.id, o.sort, o.id
  loop
    if v_eleccion.precio < 0 then
      raise exception using errcode = '22023',
        message = format('%s tiene un precio no válido en %s', v_eleccion.nombre, p_product_name);
    elsif v_eleccion.precio = 0 then
      v_gratis := v_gratis || jsonb_build_array(v_eleccion.dato);
    else
      if v_eleccion.cantidad > 99 then
        raise exception using errcode = '22023', message = 'La cantidad debe estar entre 1 y 99';
      end if;
      v_con_precio := v_con_precio || jsonb_build_array(jsonb_build_object(
        'name', v_eleccion.nombre,
        'quantity', v_eleccion.cantidad,
        'unit_price', round(v_eleccion.precio, 2),
        'options', '[]'::jsonb
      ));
    end if;
  end loop;

  if v_completos > 0 then
    v_lineas := jsonb_build_array(jsonb_build_object(
      'name', p_product_name,
      'quantity', v_completos,
      'unit_price', round(p_precio, 2),
      'options', v_del_completo || v_gratis
    ));
  elsif jsonb_array_length(v_sueltas) > 0 then
    -- Sin plato completo, lo gratis acompaña a lo primero que se sirve suelto.
    v_sueltas := jsonb_set(v_sueltas, '{0,options}', (v_sueltas -> 0 -> 'options') || v_gratis);
  end if;

  return v_lineas || v_sueltas || v_con_precio;
end;
$$;
revoke all on function public.lineas_del_plato_por_partes(uuid, uuid, text, numeric, jsonb)
  from public, anon, authenticated;

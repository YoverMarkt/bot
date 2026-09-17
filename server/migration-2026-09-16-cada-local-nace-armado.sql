-- ═══════════════════════════════════════════════════════════════════════════
-- CADA LOCAL NACE ARMADO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La plantilla del alta dejaba categorías y grupos colgados de la CATEGORÍA,
-- sin un solo producto. El dueño abría su panel y encontraba «Sopa, Segundo,
-- Guarnición… lo heredan 0 productos»: piezas sueltas que no enseñaban cómo se
-- juntan en un plato.
--
-- ⚠️ Y en los almuerzos no era solo confuso: era IMPOSIBLE. Una parte del
-- plato tiene que colgar de un PRODUCTO (`option_groups_parte_del_plato_check`),
-- así que la plantilla no podía dejar armado el plato por partes que usa La
-- Abuelita. Todo almuercero acababa con dos juegos de grupos —los de la
-- plantilla y los de «Armarlo por partes»—, que es literalmente el «en el
-- panel tengo como 4 sopas» del 2026-09-16.
--
-- Esta versión de `apply_business_template` aprende tres cosas, y ninguna
-- cambia lo que ya sabía hacer:
--
--   1. `listas` — listas reutilizables (`option_templates`): los sabores de una
--      pizzería, definidos una vez. Los grupos se enlazan por NOMBRE y la base
--      llena sus opciones sola (`sincronizar_plantilla_en_grupo`, #365).
--   2. `productos` dentro de cada categoría — un producto de EJEMPLO por local,
--      armado como se arma de verdad en su tipo.
--   3. Grupos con lo que el motor ya admitía y la plantilla no sabía pedir:
--      cómo se cobra, cuántas van gratis, parte del plato, precio suelto,
--      descripción y lista.
--
-- ⚠️ UN PRODUCTO DE EJEMPLO NACE AGOTADO SIEMPRE, y lo decide ESTA función, no
-- la plantilla. Su precio es inventado: un local recién abierto que encienda
-- su tienda no puede vender una «Pizza» a un precio que nadie puso. Agotado,
-- la tienda lo pinta sin botón y `create_storefront_order` lo rechaza. No hay
-- campo para pedir lo contrario.
--
-- ⚠️ AGOTADO, NO `active = false`, y no es un matiz. En este sistema un
-- producto inactivo es un producto BORRADO: el panel borra poniendo
-- `active = false` y lista solo los activos. Un ejemplo «oculto» nacería
-- invisible para su dueño, que no podría ni encontrarlo ni encenderlo. Se vio
-- al compilar el panel, antes de desplegar nada.
--
-- ⚠️ Una lista que la plantilla no trae es un error de la PLANTILLA, no del
-- negocio: se rechaza entera (todo o nada, como siempre) en vez de dejar un
-- combo con un paso vacío que la tienda descartaría en silencio.
--
-- El portón mira ahora también las listas: quien ya armó una tomó decisiones.
--
-- Lo que NO toca: los negocios existentes (el portón no deja), la tienda,
-- `create_storefront_order`, `quoteCart` ni los precios. La firma no cambia,
-- así que `create or replace` sustituye la función y conserva sus permisos.

create or replace function public.apply_business_template(
  p_business_id uuid,
  p_template jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lista jsonb;
  v_item jsonb;
  v_lista_id uuid;
  v_listas_por_nombre jsonb := '{}'::jsonb;
  v_categoria jsonb;
  v_producto jsonb;
  v_destino jsonb;
  v_destinos jsonb;
  v_grupo jsonb;
  v_opcion jsonb;
  v_categoria_id uuid;
  v_producto_id uuid;
  v_grupo_id uuid;
  v_listas integer := 0;
  v_categorias integer := 0;
  v_productos integer := 0;
  v_grupos integer := 0;
  v_opciones integer := 0;
begin
  if p_business_id is null then
    raise exception 'Falta el negocio' using errcode = '22023';
  end if;

  if not exists (select 1 from businesses where id = p_business_id) then
    raise exception 'El negocio no existe' using errcode = '42501';
  end if;

  -- El portón: un negocio con catálogo ya es un negocio con decisiones
  -- tomadas, y una plantilla encima las pisaría.
  if exists (select 1 from product_categories where business_id = p_business_id)
     or exists (select 1 from products where business_id = p_business_id)
     or exists (select 1 from option_templates where business_id = p_business_id) then
    return jsonb_build_object(
      'aplicada', false,
      'motivo', 'El negocio ya tiene catálogo',
      'categorias', 0, 'listas', 0, 'productos', 0, 'grupos', 0, 'opciones', 0
    );
  end if;

  -- ── 1. Las listas, ANTES que los grupos que se enlazan a ellas ────────────
  for v_lista in
    select * from jsonb_array_elements(coalesce(p_template->'listas', '[]'::jsonb))
  loop
    insert into option_templates (business_id, name, description)
    values (p_business_id, v_lista->>'nombre', v_lista->>'descripcion')
    returning id into v_lista_id;
    v_listas_por_nombre := v_listas_por_nombre
      || jsonb_build_object(v_lista->>'nombre', v_lista_id);
    v_listas := v_listas + 1;

    for v_item in
      select * from jsonb_array_elements(coalesce(v_lista->'opciones', '[]'::jsonb))
    loop
      insert into option_template_items (
        business_id, option_template_id, name, price_adjustment, sort
      ) values (
        p_business_id,
        v_lista_id,
        v_item->>'nombre',
        coalesce((v_item->>'recargo')::numeric, 0),
        coalesce((v_item->>'orden')::integer, 0)
      );
    end loop;
  end loop;

  -- ── 2. Categorías, sus productos de ejemplo y los grupos de cada uno ──────
  for v_categoria in
    select * from jsonb_array_elements(coalesce(p_template->'categorias', '[]'::jsonb))
  loop
    insert into product_categories (business_id, name, sort)
    values (
      p_business_id,
      v_categoria->>'nombre',
      coalesce((v_categoria->>'orden')::integer, 0)
    )
    returning id into v_categoria_id;
    v_categorias := v_categorias + 1;

    -- Un grupo cuelga de la categoría (producto nulo) o de un producto. Se
    -- juntan en una sola lista de destinos para que haya UN solo sitio donde
    -- se inserta un grupo, y no dos copias que acaben diciendo cosas distintas.
    v_destinos := jsonb_build_array(jsonb_build_object(
      'producto', null,
      'grupos', coalesce(v_categoria->'grupos', '[]'::jsonb)
    ));

    for v_producto in
      select * from jsonb_array_elements(coalesce(v_categoria->'productos', '[]'::jsonb))
    loop
      insert into products (
        business_id, category_id, name, price, description, product_type,
        active, sort, stock
      ) values (
        p_business_id,
        v_categoria_id,
        v_producto->>'nombre',
        (v_producto->>'precio')::numeric,
        v_producto->>'descripcion',
        coalesce(v_producto->>'tipo', 'simple'),
        -- ⚠️ Visible para su dueño y agotado para el cliente: ver la cabecera.
        true,
        coalesce((v_producto->>'orden')::integer, 0),
        'agotado'
      )
      returning id into v_producto_id;
      v_productos := v_productos + 1;

      v_destinos := v_destinos || jsonb_build_array(jsonb_build_object(
        'producto', v_producto_id,
        'grupos', coalesce(v_producto->'grupos', '[]'::jsonb)
      ));
    end loop;

    for v_destino in select * from jsonb_array_elements(v_destinos)
    loop
      v_producto_id := (v_destino->>'producto')::uuid;

      for v_grupo in select * from jsonb_array_elements(v_destino->'grupos')
      loop
        v_lista_id := null;
        if v_grupo ? 'lista' then
          v_lista_id := (v_listas_por_nombre->>(v_grupo->>'lista'))::uuid;
          if v_lista_id is null then
            raise exception 'La plantilla enlaza «%» a la lista «%», que no trae',
              v_grupo->>'nombre', v_grupo->>'lista'
              using errcode = '22023';
          end if;
        end if;

        insert into option_groups (
          business_id, category_id, product_id, name, description,
          selection_type, required, min_selectable, max_selectable, sort,
          pricing_strategy, free_selections, is_meal_part, loose_price,
          option_template_id
        ) values (
          p_business_id,
          case when v_producto_id is null then v_categoria_id end,
          v_producto_id,
          v_grupo->>'nombre',
          v_grupo->>'descripcion',
          coalesce(v_grupo->>'tipo', 'single'),
          coalesce((v_grupo->>'obligatorio')::boolean, false),
          coalesce((v_grupo->>'min')::integer, 0),
          coalesce((v_grupo->>'max')::integer, 1),
          coalesce((v_grupo->>'orden')::integer, 0),
          coalesce(v_grupo->>'cobro', 'sum'),
          coalesce((v_grupo->>'gratis')::integer, 0),
          coalesce((v_grupo->>'parte')::boolean, false),
          (v_grupo->>'precioSuelto')::numeric,
          v_lista_id
        )
        returning id into v_grupo_id;
        v_grupos := v_grupos + 1;

        for v_opcion in
          select * from jsonb_array_elements(coalesce(v_grupo->'opciones', '[]'::jsonb))
        loop
          insert into options (
            business_id, option_group_id, name, price_adjustment, sort
          ) values (
            p_business_id,
            v_grupo_id,
            v_opcion->>'nombre',
            coalesce((v_opcion->>'recargo')::numeric, 0),
            coalesce((v_opcion->>'orden')::integer, 0)
          );
        end loop;

        -- Se cuentan las que QUEDARON, no las que traía el JSON: un grupo
        -- enlazado a una lista no trae ninguna y la base le pone las copias.
        v_opciones := v_opciones
          + (select count(*) from options where option_group_id = v_grupo_id);
      end loop;
    end loop;
  end loop;

  return jsonb_build_object(
    'aplicada', true,
    'categorias', v_categorias,
    'listas', v_listas,
    'productos', v_productos,
    'grupos', v_grupos,
    'opciones', v_opciones
  );
end;
$$;

revoke all on function public.apply_business_template(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_business_template(uuid, jsonb)
  to service_role;

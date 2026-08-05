-- ============================================================================
-- LA PLANTILLA DEL TIPO DE NEGOCIO
--
-- Deja cargadas las categorías y los grupos de opciones típicos de un negocio
-- recién creado. Es lo que convierte «dar de alta una hamburguesería» en
-- cargar datos en vez de escribir la carta entera a mano: nace con Hamburguesas,
-- Combos, Acompañantes y Bebidas, y con sus grupos de Término, Extras y Retira
-- ingredientes ya puestos.
--
-- El contenido de cada plantilla vive en `server/src/services/business-templates.ts`
-- y viaja hasta aquí como jsonb. Aquí solo está el cómo se escribe.
--
-- ── Tres cosas que hace, y por qué ──────────────────────────────────────────
--
--   1. NO SOBRESCRIBE. Si el negocio ya tiene una categoría o un producto, no
--      toca nada y devuelve `aplicada: false`. La regla del proyecto es que el
--      tipo solo RECOMIENDA al crear —igual que `takes_orders` o `chat_mode`—,
--      y aquí lo impide la base en vez de la buena memoria de quien llame a la
--      función dentro de seis meses.
--   2. Es TODO O NADA. Media plantilla —categorías sin sus grupos— es un
--      estado que nadie sabe leer después.
--   3. Sus grupos cuelgan de la CATEGORÍA, que es lo que hace posible cargarlos
--      cuando el negocio todavía no tiene ni un producto
--      (migration-2026-08-05-grupos-por-categoria.sql).
--
-- Idempotente. Aditiva. Sin pérdida de datos.
-- ============================================================================

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
  v_categoria jsonb;
  v_grupo jsonb;
  v_opcion jsonb;
  v_categoria_id uuid;
  v_grupo_id uuid;
  v_categorias integer := 0;
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
     or exists (select 1 from products where business_id = p_business_id) then
    return jsonb_build_object(
      'aplicada', false,
      'motivo', 'El negocio ya tiene catálogo',
      'categorias', 0, 'grupos', 0, 'opciones', 0
    );
  end if;

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

    for v_grupo in
      select * from jsonb_array_elements(coalesce(v_categoria->'grupos', '[]'::jsonb))
    loop
      insert into option_groups (
        business_id, category_id, product_id, name, selection_type,
        required, min_selectable, max_selectable, sort
      ) values (
        p_business_id,
        v_categoria_id,
        null,
        v_grupo->>'nombre',
        coalesce(v_grupo->>'tipo', 'single'),
        coalesce((v_grupo->>'obligatorio')::boolean, false),
        coalesce((v_grupo->>'min')::integer, 0),
        coalesce((v_grupo->>'max')::integer, 1),
        coalesce((v_grupo->>'orden')::integer, 0)
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
        v_opciones := v_opciones + 1;
      end loop;
    end loop;
  end loop;

  return jsonb_build_object(
    'aplicada', true,
    'categorias', v_categorias,
    'grupos', v_grupos,
    'opciones', v_opciones
  );
end;
$$;

revoke all on function public.apply_business_template(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_business_template(uuid, jsonb)
  to service_role;

-- ── Comprobación inmediata ──────────────────────────────────────────────────
do $comprobacion$
declare
  v_limpio uuid; v_con_categoria uuid; v_con_producto uuid;
  v_resultado jsonb;
  v_plantilla jsonb := jsonb_build_object('categorias', jsonb_build_array(
    jsonb_build_object(
      'nombre', 'Hamburguesas', 'orden', 0,
      'grupos', jsonb_build_array(
        jsonb_build_object(
          'nombre', 'Término de la carne', 'tipo', 'single',
          'obligatorio', true, 'min', 1, 'max', 1, 'orden', 0,
          'opciones', jsonb_build_array(
            jsonb_build_object('nombre', 'Tres cuartos', 'recargo', 0, 'orden', 0),
            jsonb_build_object('nombre', 'Bien cocida', 'recargo', 0, 'orden', 1)
          )
        )
      )
    ),
    jsonb_build_object('nombre', 'Bebidas', 'orden', 1)
  ));
begin
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders)
  values ('plantilla-limpio', 'Limpio', 'hamburguesería', 'ycloud', '+593900666001', '+593900666001', true)
  returning id into v_limpio;
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders)
  values ('plantilla-categoria', 'Con categoría', 'hamburguesería', 'ycloud', '+593900666002', '+593900666002', true)
  returning id into v_con_categoria;
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders)
  values ('plantilla-producto', 'Con producto', 'hamburguesería', 'ycloud', '+593900666003', '+593900666003', true)
  returning id into v_con_producto;

  insert into product_categories (business_id, name) values (v_con_categoria, 'Ya existía');
  insert into products (business_id, name, price, stock, active)
  values (v_con_producto, 'Ya existía', 5, 'disponible', true);

  -- En un negocio recién creado deja categorías, grupos y opciones.
  v_resultado := apply_business_template(v_limpio, v_plantilla);
  if (v_resultado->>'aplicada')::boolean is not true
     or (v_resultado->>'categorias')::integer <> 2
     or (v_resultado->>'grupos')::integer <> 1
     or (v_resultado->>'opciones')::integer <> 2 then
    raise exception 'La plantilla no cargó lo esperado: %', v_resultado;
  end if;

  -- Y el grupo cuelga de la categoría, con su obligatoriedad intacta: es lo
  -- que permite que exista antes que el catálogo.
  if not exists (
    select 1 from option_groups
    where business_id = v_limpio and category_id is not null and product_id is null
      and name = 'Término de la carne' and required and min_selectable = 1
      and selection_type = 'single'
  ) then
    raise exception 'El grupo de la plantilla no quedó colgado de su categoría';
  end if;

  -- EL PORTÓN, por los dos lados. Con categorías previas…
  v_resultado := apply_business_template(v_con_categoria, v_plantilla);
  if (v_resultado->>'aplicada')::boolean is not false then
    raise exception 'La plantilla pisó un negocio con categorías: %', v_resultado;
  end if;
  if (select count(*) from product_categories where business_id = v_con_categoria) <> 1 then
    raise exception 'La plantilla añadió categorías donde ya había';
  end if;

  -- …y con productos previos, aunque no tenga ni una categoría.
  v_resultado := apply_business_template(v_con_producto, v_plantilla);
  if (v_resultado->>'aplicada')::boolean is not false then
    raise exception 'La plantilla pisó un negocio con productos: %', v_resultado;
  end if;
  if exists (select 1 from product_categories where business_id = v_con_producto) then
    raise exception 'La plantilla creó categorías en un negocio con productos';
  end if;

  -- Un negocio que no existe no se puede sembrar a ciegas.
  begin
    v_resultado := apply_business_template(gen_random_uuid(), v_plantilla);
    raise exception 'Se aplicó una plantilla a un negocio inexistente';
  exception when insufficient_privilege then null;
  end;

  delete from businesses where id in (v_limpio, v_con_categoria, v_con_producto);
  raise notice 'PLANTILLAS: carga completa, portón cerrado por ambos lados y negocio inexistente rechazado';
end;
$comprobacion$;

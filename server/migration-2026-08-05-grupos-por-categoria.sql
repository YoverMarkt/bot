-- ============================================================================
-- EL GRUPO DE OPCIONES PUEDE COLGAR DE UNA CATEGORÍA
--
-- La migración de ayer (motor-de-opciones) prometía copiar los modificadores
-- que ya existían. Copió CERO de 19, y el motivo no era el SQL sino la premisa:
--
--     DIAGNOSTICO: { sin_producto: 19, producto_inexistente: 0, enlazados: 0 }
--
-- Los 19 sabores de la pizzería cuelgan de `category_tag='pizzas'` con
-- `product_id` NULL. En `menu_modifiers` un modificador se aplica a una
-- CATEGORÍA entera; en `option_groups` el `product_id` era NOT NULL. El bucle
-- de copia exigía producto y no encontró ninguno.
--
-- La misma pared bloquea las plantillas por tipo de negocio: al crear una
-- hamburguesería no existe todavía ni un producto del que colgar «Término de
-- la carne», así que no había forma de dejar los grupos típicos ya cargados.
--
-- Y hay un tercer caso que solo se ve con el catálogo delante: 19 sabores
-- compartidos por todas las pizzas habría que repetirlos en cada pizza, y
-- añadir un sabor nuevo sería editarlas una por una.
--
-- Las tres cosas son la misma: un grupo tiene que poder colgar de un producto
-- O de una categoría. Es lo que `menu_modifiers` YA hace en producción; esto
-- lo lleva al modelo nuevo.
--
-- ── Qué NO hace ─────────────────────────────────────────────────────────────
-- No borra `menu_modifiers` ni toca sus 19 filas: las copia, como la anterior.
-- No toca los grupos que ya cuelgan de un producto. No cambia ninguna ruta.
--
-- Idempotente. Aditiva. Sin pérdida de datos.
-- ============================================================================

-- ── 1. El destino puede ser una categoría ───────────────────────────────────
-- `product_categories` necesita el único (id, business_id) ANTES de que nadie
-- lo use como destino de una foránea compuesta: PostgreSQL exige un único que
-- case exactamente con la pareja.
create unique index if not exists uq_product_categories_id_business
  on public.product_categories (id, business_id);

alter table public.option_groups
  add column if not exists category_id uuid;

alter table public.option_groups
  alter column product_id drop not null;

-- El grupo cuelga de UNO de los dos, nunca de ninguno y nunca de ambos:
--   · de ninguno → un grupo que no le aparece a nadie, invisible y vivo
--   · de ambos   → la app tendría que decidir cuál manda, y decidiría mal
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.option_groups'::regclass
      and conname = 'option_groups_destino_check'
  ) then
    alter table public.option_groups
      add constraint option_groups_destino_check
      check (num_nonnulls(product_id, category_id) = 1);
  end if;
end $$;

-- La categoría, igual que el producto, se referencia por PAREJA. Sin el
-- business_id dentro, la foránea comprueba «esa categoría existe» y no «esa
-- categoría es de este negocio», que es justo por donde se cruzó la frontera
-- con `product_variants` y `products.category_id` el 2026-08-02.
--
-- Va en CASCADE y no en `set null`, y no es una preferencia: con el check de
-- arriba, anular `category_id` dejaría el grupo sin destino y borrar una
-- categoría reventaría con una violación de check.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.option_groups'::regclass
      and conname = 'fk_option_groups_categoria_del_negocio'
  ) then
    alter table public.option_groups
      add constraint fk_option_groups_categoria_del_negocio
      foreign key (category_id, business_id)
      references public.product_categories (id, business_id) on delete cascade;
  end if;
end $$;

create index if not exists idx_option_groups_categoria
  on public.option_groups (business_id, category_id, sort);

-- ── 2. La repesca de los 19 ─────────────────────────────────────────────────
-- Ahora sí se pueden copiar los modificadores que cuelgan de una categoría.
--
-- El enganche es delicado: `menu_modifiers.category_tag` es TEXTO LIBRE
-- ('pizzas') y `product_categories.name` es un nombre de verdad ('Pizzas').
-- No hay foránea entre ellos. Se casan normalizando —minúsculas, sin espacios
-- de sobra, sin acentos— y solo cuando la coincidencia es ÚNICA: ante dos
-- categorías candidatas no se adivina, se deja fuera y se avisa. Copiar un
-- sabor a la categoría equivocada es peor que no copiarlo.
--
-- Lo que la tabla vieja no guardaba se pone en el valor MENOS restrictivo
-- (opcional, sin mínimo), igual que en la migración hermana: marcar como
-- obligatorio algo que nunca lo fue dejaría productos que no se pueden pedir.
do $$
declare
  v_fila record;
  v_categoria uuid;
  v_candidatas integer;
  v_grupo uuid;
  v_copiados integer := 0;
  v_sin_categoria integer := 0;
  v_ambiguos integer := 0;
begin
  for v_fila in
    select m.business_id, m.category_tag, m.group_label,
           max(coalesce(m.max_selectable, 1)) as tope
    from public.menu_modifiers m
    where m.product_id is null and m.active
    group by m.business_id, m.category_tag, m.group_label
  loop
    -- ¿A qué categoría real corresponde esta etiqueta de texto?
    select count(*) into v_candidatas
    from public.product_categories pc
    where pc.business_id = v_fila.business_id
      and translate(lower(btrim(pc.name)), 'áéíóúüñ', 'aeiouun')
        = translate(lower(btrim(v_fila.category_tag)), 'áéíóúüñ', 'aeiouun');

    if v_candidatas = 0 then
      v_sin_categoria := v_sin_categoria + 1;
      continue;
    elsif v_candidatas > 1 then
      v_ambiguos := v_ambiguos + 1;
      continue;
    end if;

    select pc.id into v_categoria
    from public.product_categories pc
    where pc.business_id = v_fila.business_id
      and translate(lower(btrim(pc.name)), 'áéíóúüñ', 'aeiouun')
        = translate(lower(btrim(v_fila.category_tag)), 'áéíóúüñ', 'aeiouun');

    -- Sin duplicar si la migración se corre dos veces.
    select id into v_grupo
    from public.option_groups
    where business_id = v_fila.business_id
      and category_id = v_categoria
      and name = v_fila.group_label;

    if v_grupo is null then
      insert into public.option_groups (
        business_id, category_id, product_id, name, selection_type,
        required, min_selectable, max_selectable
      ) values (
        v_fila.business_id, v_categoria, null, v_fila.group_label, 'multiple',
        false, 0, greatest(v_fila.tope, 1)
      ) returning id into v_grupo;
    end if;

    insert into public.options (
      business_id, option_group_id, name, description, price_adjustment, sort, active
    )
    select m.business_id, v_grupo, m.name, m.description,
           coalesce(m.price_delta, 0), m.sort, m.active
    from public.menu_modifiers m
    where m.business_id = v_fila.business_id
      and m.category_tag = v_fila.category_tag
      and m.group_label = v_fila.group_label
      and m.product_id is null
      and m.active
      and not exists (
        select 1 from public.options o
        where o.option_group_id = v_grupo and o.name = m.name
      );

    v_copiados := v_copiados + 1;
  end loop;

  raise notice 'REPESCA: % grupo(s) de categoría copiados · % sin categoría que case · % ambiguos (la tabla vieja NO se toca)',
    v_copiados, v_sin_categoria, v_ambiguos;
end $$;

-- ── Comprobación inmediata ──────────────────────────────────────────────────
-- Se ejercita lo que de verdad importa: que la frontera nueva esté cerrada y
-- que el destino del grupo sea exactamente uno.
do $comprobacion$
declare
  v_a uuid; v_b uuid; v_pa uuid; v_ca uuid; v_cb uuid; v_g uuid;
begin
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders)
  values ('categoria-a', 'A', 'hamburguesería', 'ycloud', '+593900555001', '+593900555001', true)
  returning id into v_a;
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders)
  values ('categoria-b', 'B', 'hamburguesería', 'ycloud', '+593900555002', '+593900555002', true)
  returning id into v_b;

  insert into product_categories (business_id, name)
  values (v_b, 'Pizzas de B') returning id into v_cb;

  -- FRONTERA: A no puede colgar un grupo de la categoría de B.
  begin
    insert into option_groups (business_id, category_id, name)
    values (v_a, v_cb, 'Sabor');
    raise exception 'FUGA: A colgó un grupo de la categoría de B';
  exception when foreign_key_violation then null;
  end;

  -- DESTINO: ni ninguno…
  begin
    insert into option_groups (business_id, name) values (v_a, 'Huérfano');
    raise exception 'Se admitió un grupo que no cuelga de nada';
  exception when check_violation then null;
  end;

  insert into product_categories (business_id, name)
  values (v_a, 'Pizzas de A') returning id into v_ca;
  insert into products (business_id, name, price, stock, active)
  values (v_a, 'Pizza de A', 10, 'disponible', true) returning id into v_pa;

  -- …ni los dos a la vez.
  begin
    insert into option_groups (business_id, category_id, product_id, name)
    values (v_a, v_ca, v_pa, 'Ambos');
    raise exception 'Se admitió un grupo colgado de producto Y categoría';
  exception when check_violation then null;
  end;

  -- El uso legítimo funciona, y los dos destinos conviven.
  insert into option_groups (business_id, category_id, name)
  values (v_a, v_ca, 'Sabor') returning id into v_g;
  insert into options (business_id, option_group_id, name)
  values (v_a, v_g, 'Hawaiana');
  insert into option_groups (business_id, product_id, name)
  values (v_a, v_pa, 'Término');

  -- Borrar la categoría se lleva su grupo y sus opciones, y no revienta por el
  -- check del destino: por eso la foránea va en cascade y no en `set null`.
  delete from product_categories where id = v_ca;
  if exists (select 1 from option_groups where id = v_g) then
    raise exception 'Borrar la categoría dejó su grupo huérfano';
  end if;
  if exists (select 1 from options where option_group_id = v_g) then
    raise exception 'Borrar la categoría dejó opciones huérfanas';
  end if;
  -- Y no se llevó el grupo del producto, que no era suyo.
  if not exists (select 1 from option_groups where business_id = v_a and product_id = v_pa) then
    raise exception 'Borrar la categoría se llevó el grupo de un producto';
  end if;

  delete from businesses where id in (v_a, v_b);
  raise notice 'GRUPOS POR CATEGORÍA: frontera cerrada y destino único comprobados';
end;
$comprobacion$;

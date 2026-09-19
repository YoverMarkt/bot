-- ═══════════════════════════════════════════════════════════════════════════
-- EL MENÚ DEL LOCAL DE PRUEBAS — una pizzería como las cadenas grandes
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Lo aplica `tests/staging.mjs` sobre el local `demo` del staging. Solo corre
-- contra una base local: la guardia de ese script se niega a tocar otra cosa.
--
-- ⚠️ NO es un menú de adorno. Está armado para EXIGIRLE al motor de opciones
-- lo que un local real le va a exigir, y para que se vea si aguanta:
--
--   · **Tamaño como producto, no como opción.** Es la diferencia de fondo con
--     Monster Pizza, que tiene un solo «Pizza» a $2,75. En una cadena el
--     tamaño cambia TODOS los demás precios: el extra de queso no cuesta igual
--     en una personal que en una familiar. Con un grupo «Tamaño» habría que
--     cobrar el mismo extra a las cuatro, que es justo lo que ningún local
--     hace. Cuatro productos, cada uno con sus precios.
--   · **Mitad y mitad con `highest_selected`**: se eligen hasta dos sabores y
--     se paga el más caro, no la suma. Dos medias pizzas son una pizza.
--   · **Los combos usan `included`**: lo que va dentro no vuelve a sumar. Un
--     combo que cobrara aparte su bebida «incluida» sería un engaño.
--   · **`quantity` en las alitas**: se eligen 8, 16 o 24 y el precio acompaña.
--   · **Una plantilla reutilizada** («Quitar ingredientes») en los cuatro
--     tamaños, que es para lo que existen las plantillas.
--
-- Los precios son de pizzería de Ecuador, no inventados al azar.

do $$
declare
  v_negocio   uuid;
  v_cat_pizza uuid;
  v_cat_combo uuid;
  v_cat_acomp uuid;
  v_cat_bebida uuid;
  v_cat_postre uuid;
  v_personal  uuid;
  v_mediana   uuid;
  v_grande    uuid;
  v_familiar  uuid;
  v_grupo     uuid;
  v_plantilla uuid;
  v_producto  uuid;
  v_tam       record;
begin
  select id into v_negocio from businesses where slug = 'demo';
  if v_negocio is null then
    raise exception 'No existe el local «demo»: corre primero npm run staging:preparar';
  end if;

  -- Se parte de cero para que aplicarlo dos veces dé el mismo menú.
  delete from products           where business_id = v_negocio;
  delete from product_categories where business_id = v_negocio;
  delete from option_templates   where business_id = v_negocio;

  -- ── LAS CATEGORÍAS ─────────────────────────────────────────────────
  insert into product_categories (business_id, name, sort, active) values
    (v_negocio, 'Pizzas',          1, true) returning id into v_cat_pizza;
  insert into product_categories (business_id, name, sort, active) values
    (v_negocio, 'Combos',          2, true) returning id into v_cat_combo;
  insert into product_categories (business_id, name, sort, active) values
    (v_negocio, 'Para acompañar',  3, true) returning id into v_cat_acomp;
  insert into product_categories (business_id, name, sort, active) values
    (v_negocio, 'Bebidas',         4, true) returning id into v_cat_bebida;
  insert into product_categories (business_id, name, sort, active) values
    (v_negocio, 'Postres',         5, true) returning id into v_cat_postre;

  -- ── LA PLANTILLA QUE SE REUTILIZA ──────────────────────────────────
  --
  -- Quitar un ingrediente nunca cuesta, así que la lista es idéntica en los
  -- cuatro tamaños: es exactamente el caso para el que existen las plantillas.
  insert into option_templates (business_id, name, description, active)
  values (v_negocio, 'Quitar ingredientes', 'Lo que el cliente prefiere que no lleve', true)
  returning id into v_plantilla;

  insert into option_template_items (business_id, option_template_id, name, price_adjustment, sort, active)
  values
    (v_negocio, v_plantilla, 'Sin cebolla',     0, 1, true),
    (v_negocio, v_plantilla, 'Sin aceitunas',   0, 2, true),
    (v_negocio, v_plantilla, 'Sin champiñones', 0, 3, true),
    (v_negocio, v_plantilla, 'Sin pimiento',    0, 4, true),
    (v_negocio, v_plantilla, 'Sin orégano',     0, 5, true);

  -- ── LAS CUATRO PIZZAS ──────────────────────────────────────────────
  insert into products (business_id, category_id, name, description, price, stock, active, sort, preparation_time)
  values (v_negocio, v_cat_pizza, 'Pizza Personal', '1 porción grande · ideal para uno', 5.99, 'disponible', true, 1, 20)
  returning id into v_personal;
  insert into products (business_id, category_id, name, description, price, stock, active, sort, preparation_time)
  values (v_negocio, v_cat_pizza, 'Pizza Mediana', '6 porciones · para dos', 11.99, 'disponible', true, 2, 25)
  returning id into v_mediana;
  insert into products (business_id, category_id, name, description, price, stock, active, sort, preparation_time)
  values (v_negocio, v_cat_pizza, 'Pizza Grande', '8 porciones · para tres', 15.99, 'disponible', true, 3, 25)
  returning id into v_grande;
  insert into products (business_id, category_id, name, description, price, stock, active, sort, preparation_time)
  values (v_negocio, v_cat_pizza, 'Pizza Familiar', '12 porciones · para cuatro o cinco', 19.99, 'disponible', true, 4, 30)
  returning id into v_familiar;

  -- Los grupos de cada tamaño, con los precios escalados. El bucle recorre los
  -- cuatro con su factor: lo que en la personal cuesta $1, en la familiar $2,5.
  for v_tam in
    select * from (values
      (v_personal, 1.00::numeric, 4),
      (v_mediana,  1.60::numeric, 5),
      (v_grande,   2.00::numeric, 6),
      (v_familiar, 2.50::numeric, 6)
    ) as t(producto, factor, max_extras)
  loop
    -- SABOR — hasta dos, y se paga el MÁS CARO, no la suma.
    insert into option_groups (business_id, product_id, name, description, selection_type,
                               required, min_selectable, max_selectable, pricing_strategy, sort, active)
    values (v_negocio, v_tam.producto, 'Sabor', 'Puedes pedir mitad y mitad',
            'multiple', true, 1, 2, 'highest_selected', 1, true)
    returning id into v_grupo;

    insert into options (business_id, option_group_id, name, price_adjustment, sort, active, stock)
    values
      (v_negocio, v_grupo, 'Pepperoni',        0,                          1,  true, 'disponible'),
      (v_negocio, v_grupo, 'Hawaiana',         0,                          2,  true, 'disponible'),
      (v_negocio, v_grupo, 'Margarita',        0,                          3,  true, 'disponible'),
      (v_negocio, v_grupo, 'Jamón y queso',    0,                          4,  true, 'disponible'),
      (v_negocio, v_grupo, 'Vegetariana',      0,                          5,  true, 'disponible'),
      (v_negocio, v_grupo, 'Criolla',          0,                          6,  true, 'disponible'),
      (v_negocio, v_grupo, 'Mexicana',         round(0.80 * v_tam.factor, 2), 7,  true, 'disponible'),
      (v_negocio, v_grupo, 'Pollo BBQ',        round(1.00 * v_tam.factor, 2), 8,  true, 'disponible'),
      (v_negocio, v_grupo, 'Carnívora',        round(1.50 * v_tam.factor, 2), 9,  true, 'disponible'),
      (v_negocio, v_grupo, 'Cuatro quesos',    round(1.50 * v_tam.factor, 2), 10, true, 'disponible'),
      (v_negocio, v_grupo, 'Suprema',          round(2.00 * v_tam.factor, 2), 11, true, 'disponible'),
      (v_negocio, v_grupo, 'Marinera',         round(2.50 * v_tam.factor, 2), 12, true, 'agotado');

    -- MASA — obligatoria y una sola.
    insert into option_groups (business_id, product_id, name, selection_type,
                               required, min_selectable, max_selectable, pricing_strategy, sort, active)
    values (v_negocio, v_tam.producto, 'Masa', 'single', true, 1, 1, 'sum', 2, true)
    returning id into v_grupo;

    insert into options (business_id, option_group_id, name, price_adjustment, default_selected, sort, active, stock)
    values
      (v_negocio, v_grupo, 'Tradicional',      0,                             true,  1, true, 'disponible'),
      (v_negocio, v_grupo, 'Delgada y crujiente', 0,                          false, 2, true, 'disponible'),
      (v_negocio, v_grupo, 'Pan Pizza',        round(1.00 * v_tam.factor, 2), false, 3, true, 'disponible'),
      (v_negocio, v_grupo, 'Integral',         round(0.80 * v_tam.factor, 2), false, 4, true, 'disponible');

    -- BORDE — opcional.
    insert into option_groups (business_id, product_id, name, selection_type,
                               required, min_selectable, max_selectable, pricing_strategy, sort, active)
    values (v_negocio, v_tam.producto, 'Borde', 'single', false, 0, 1, 'sum', 3, true)
    returning id into v_grupo;

    insert into options (business_id, option_group_id, name, price_adjustment, default_selected, sort, active, stock)
    values
      (v_negocio, v_grupo, 'Sin borde',          0,                             true,  1, true, 'disponible'),
      (v_negocio, v_grupo, 'Relleno de queso',   round(1.50 * v_tam.factor, 2), false, 2, true, 'disponible'),
      (v_negocio, v_grupo, 'Relleno de pepperoni', round(2.00 * v_tam.factor, 2), false, 3, true, 'disponible');

    -- EXTRAS — varios, y cada uno suma.
    insert into option_groups (business_id, product_id, name, description, selection_type,
                               required, min_selectable, max_selectable, pricing_strategy, sort, active)
    values (v_negocio, v_tam.producto, 'Extras', 'Añade lo que quieras',
            'multiple', false, 0, v_tam.max_extras, 'sum', 4, true)
    returning id into v_grupo;

    insert into options (business_id, option_group_id, name, price_adjustment, sort, active, stock)
    values
      (v_negocio, v_grupo, 'Extra queso',   round(1.00 * v_tam.factor, 2), 1, true, 'disponible'),
      (v_negocio, v_grupo, 'Pepperoni',     round(1.00 * v_tam.factor, 2), 2, true, 'disponible'),
      (v_negocio, v_grupo, 'Jamón',         round(1.00 * v_tam.factor, 2), 3, true, 'disponible'),
      (v_negocio, v_grupo, 'Tocino',        round(1.20 * v_tam.factor, 2), 4, true, 'disponible'),
      (v_negocio, v_grupo, 'Champiñones',   round(0.70 * v_tam.factor, 2), 5, true, 'disponible'),
      (v_negocio, v_grupo, 'Pimiento',      round(0.60 * v_tam.factor, 2), 6, true, 'disponible'),
      (v_negocio, v_grupo, 'Aceitunas',     round(0.60 * v_tam.factor, 2), 7, true, 'disponible'),
      (v_negocio, v_grupo, 'Piña',          round(0.70 * v_tam.factor, 2), 8, true, 'disponible');

    -- QUITAR INGREDIENTES — desde la plantilla, idéntico en los cuatro.
    insert into option_groups (business_id, product_id, name, selection_type,
                               required, min_selectable, max_selectable, pricing_strategy,
                               option_template_id, sort, active)
    values (v_negocio, v_tam.producto, 'Quitar ingredientes', 'multiple', false, 0, 5, 'sum',
            v_plantilla, 5, true)
    returning id into v_grupo;

    -- ⚠️ Y AQUÍ NO SE COPIA NADA A MANO. El disparador
    -- `option_groups_sincronizar_plantilla` ya rellena el grupo con los ítems
    -- de su plantilla al crearlo. Copiarlos además reventaba contra
    -- `uq_options_copia_por_grupo` —el índice que existe justamente para que
    -- dos sincronizaciones no dupliquen un sabor—, que es el motor
    -- defendiéndose bien de algo que estaba haciendo mal.
    null;
  end loop;

  -- ── PARA ACOMPAÑAR ─────────────────────────────────────────────────
  insert into products (business_id, category_id, name, description, price, stock, active, sort, preparation_time)
  values (v_negocio, v_cat_acomp, 'Alitas', 'Crujientes, con la salsa que elijas', 7.99, 'disponible', true, 1, 20)
  returning id into v_producto;

  -- CUÁNTAS — `quantity`: el cliente elige la cantidad y el precio acompaña.
  insert into option_groups (business_id, product_id, name, selection_type,
                             required, min_selectable, max_selectable, pricing_strategy, sort, active)
  values (v_negocio, v_producto, '¿Cuántas?', 'single', true, 1, 1, 'sum', 1, true)
  returning id into v_grupo;
  insert into options (business_id, option_group_id, name, price_adjustment, default_selected, sort, active, stock)
  values
    (v_negocio, v_grupo, '8 alitas',   0,    true,  1, true, 'disponible'),
    (v_negocio, v_grupo, '16 alitas',  6.00, false, 2, true, 'disponible'),
    (v_negocio, v_grupo, '24 alitas',  11.00, false, 3, true, 'disponible');

  -- SALSA — dos incluidas, la tercera se paga. `included_up_to_limit`.
  insert into option_groups (business_id, product_id, name, description, selection_type,
                             required, min_selectable, max_selectable, pricing_strategy,
                             free_selections, sort, active)
  values (v_negocio, v_producto, 'Salsa', 'Las dos primeras van incluidas',
          'multiple', true, 1, 4, 'included_up_to_limit', 2, 2, true)
  returning id into v_grupo;
  insert into options (business_id, option_group_id, name, price_adjustment, sort, active, stock)
  values
    (v_negocio, v_grupo, 'BBQ',          0.75, 1, true, 'disponible'),
    (v_negocio, v_grupo, 'Búfalo',       0.75, 2, true, 'disponible'),
    (v_negocio, v_grupo, 'Miel mostaza', 0.75, 3, true, 'disponible'),
    (v_negocio, v_grupo, 'Ajo parmesano', 0.75, 4, true, 'disponible');

  insert into products (business_id, category_id, name, description, price, stock, active, sort, preparation_time)
  values
    (v_negocio, v_cat_acomp, 'Pan de ajo',     'Con queso gratinado',        3.50, 'disponible', true, 2, 12),
    (v_negocio, v_cat_acomp, 'Papas fritas',   'Porción grande',             3.99, 'disponible', true, 3, 12),
    (v_negocio, v_cat_acomp, 'Nuggets (10 u)', 'Con salsa a elegir',         5.99, 'disponible', true, 4, 15),
    (v_negocio, v_cat_acomp, 'Ensalada César', 'Con pollo a la parrilla',    6.50, 'agotado',    true, 5, 10);

  -- ── COMBOS ─────────────────────────────────────────────────────────
  --
  -- Lo que va DENTRO del combo no vuelve a cobrarse: `included`. Un combo que
  -- sumara aparte su bebida «incluida» sería mentirle al cliente en el total.
  insert into products (business_id, category_id, name, description, price, stock, active, sort, preparation_time, popular)
  values (v_negocio, v_cat_combo, 'Combo Pareja', 'Pizza mediana + 2 bebidas', 14.99, 'disponible', true, 1, 25, true)
  returning id into v_producto;

  insert into option_groups (business_id, product_id, name, selection_type,
                             required, min_selectable, max_selectable, pricing_strategy, sort, active)
  values (v_negocio, v_producto, 'Sabor de la pizza', 'single', true, 1, 1, 'included', 1, true)
  returning id into v_grupo;
  insert into options (business_id, option_group_id, name, price_adjustment, sort, active, stock)
  values
    (v_negocio, v_grupo, 'Pepperoni',     0, 1, true, 'disponible'),
    (v_negocio, v_grupo, 'Hawaiana',      0, 2, true, 'disponible'),
    (v_negocio, v_grupo, 'Jamón y queso', 0, 3, true, 'disponible'),
    (v_negocio, v_grupo, 'Vegetariana',   0, 4, true, 'disponible');

  insert into option_groups (business_id, product_id, name, description, selection_type,
                             required, min_selectable, max_selectable, pricing_strategy,
                             max_total_quantity, sort, active)
  values (v_negocio, v_producto, 'Bebidas incluidas', 'Elige dos',
          'quantity', true, 1, 2, 'included', 2, 2, true)
  returning id into v_grupo;
  insert into options (business_id, option_group_id, name, price_adjustment, sort, active, stock)
  values
    (v_negocio, v_grupo, 'Cola personal',     0, 1, true, 'disponible'),
    (v_negocio, v_grupo, 'Cola light',        0, 2, true, 'disponible'),
    (v_negocio, v_grupo, 'Té helado',         0, 3, true, 'disponible'),
    (v_negocio, v_grupo, 'Agua sin gas',      0, 4, true, 'disponible');

  insert into products (business_id, category_id, name, description, price, stock, active, sort, preparation_time, featured)
  values (v_negocio, v_cat_combo, 'Combo Familiar', 'Pizza familiar + 8 alitas + gaseosa 1,5 L', 28.99, 'disponible', true, 2, 35, true)
  returning id into v_producto;

  insert into option_groups (business_id, product_id, name, description, selection_type,
                             required, min_selectable, max_selectable, pricing_strategy, sort, active)
  values (v_negocio, v_producto, 'Sabores de la familiar', 'Hasta dos, mitad y mitad',
          'multiple', true, 1, 2, 'included', 1, true)
  returning id into v_grupo;
  insert into options (business_id, option_group_id, name, price_adjustment, sort, active, stock)
  values
    (v_negocio, v_grupo, 'Pepperoni',     0, 1, true, 'disponible'),
    (v_negocio, v_grupo, 'Hawaiana',      0, 2, true, 'disponible'),
    (v_negocio, v_grupo, 'Carnívora',     0, 3, true, 'disponible'),
    (v_negocio, v_grupo, 'Cuatro quesos', 0, 4, true, 'disponible'),
    (v_negocio, v_grupo, 'Suprema',       0, 5, true, 'disponible');

  insert into option_groups (business_id, product_id, name, selection_type,
                             required, min_selectable, max_selectable, pricing_strategy, sort, active)
  values (v_negocio, v_producto, 'Salsa de las alitas', 'single', true, 1, 1, 'included', 2, true)
  returning id into v_grupo;
  insert into options (business_id, option_group_id, name, price_adjustment, sort, active, stock)
  values
    (v_negocio, v_grupo, 'BBQ',    0, 1, true, 'disponible'),
    (v_negocio, v_grupo, 'Búfalo', 0, 2, true, 'disponible');

  insert into products (business_id, category_id, name, description, price, stock, active, sort, preparation_time)
  values (v_negocio, v_cat_combo, 'Combo Súper Panas', '2 pizzas grandes + 16 alitas + gaseosa 3 L', 44.99, 'disponible', true, 3, 40);

  -- ── BEBIDAS ────────────────────────────────────────────────────────
  insert into products (business_id, category_id, name, description, price, stock, active, sort)
  values
    (v_negocio, v_cat_bebida, 'Gaseosa personal', '400 ml',  1.00, 'disponible',        true, 1),
    (v_negocio, v_cat_bebida, 'Gaseosa 1,5 L',    null,      2.50, 'disponible',        true, 2),
    (v_negocio, v_cat_bebida, 'Gaseosa 3 L',      null,      3.99, 'últimas unidades',  true, 3),
    (v_negocio, v_cat_bebida, 'Agua sin gas',     '500 ml',  0.75, 'disponible',        true, 4),
    (v_negocio, v_cat_bebida, 'Té helado',        'Durazno o limón', 1.25, 'disponible', true, 5),
    (v_negocio, v_cat_bebida, 'Jugo natural',     'Del día', 1.75, 'disponible',        true, 6);

  -- ── POSTRES ────────────────────────────────────────────────────────
  insert into products (business_id, category_id, name, description, price, stock, active, sort)
  values
    (v_negocio, v_cat_postre, 'Brownie con helado', 'Tibio, con bola de vainilla', 3.99, 'disponible', true, 1),
    (v_negocio, v_cat_postre, 'Cheesecake',         'Porción con salsa de mora',   3.50, 'disponible', true, 2),
    (v_negocio, v_cat_postre, 'Helado (2 bolas)',   null,                          2.50, 'disponible', true, 3);

  raise notice 'Menú de pruebas listo';
end $$;

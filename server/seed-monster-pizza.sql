-- ─────────────────────────────────────────────────────────────────────────
-- Catálogo de "Monster Pizza" (carga en lote)
-- ─────────────────────────────────────────────────────────────────────────
-- Crea el catálogo REAL de la pizzería: 5 tamaños de pizza (con precio),
-- 19 sabores con sus ingredientes (como modificadores), y las categorías
-- Hamburguesas, Platos y Bebidas.
--
-- Cómo funciona la pizza: el cliente elige SABOR (con ingredientes) y luego
-- TAMAÑO (el precio sale del tamaño). El sabor viaja pegado a la línea del
-- pedido, así el dueño ve el pedido completo con el precio exacto.
--
-- ► REQUISITO: corre PRIMERO `migration-modificadores-menu.sql` (crea la tabla
--   menu_modifiers). Luego este seed.
-- ► El negocio "Monster Pizza" debe existir (créalo en el panel admin →
--   Clientes, con "Modo menú" y "recibe pedidos" activados).
-- ► Idempotente: los productos solo se cargan si el negocio aún no tiene
--   catálogo; los sabores usan ON CONFLICT DO NOTHING.
--
-- Correr en: Supabase → SQL Editor.
-- ─────────────────────────────────────────────────────────────────────────

do $$
declare
  v_id uuid;
begin
  select id into v_id
  from public.businesses
  where lower(name) = lower('Monster Pizza')
  order by created_at asc
  limit 1;

  if v_id is null then
    raise exception 'No se encontró el negocio "Monster Pizza". Créalo primero en el panel admin.';
  end if;

  -- ── Productos (solo si el negocio aún no tiene catálogo) ──
  if not exists (select 1 from public.products where business_id = v_id) then
    insert into public.products (business_id, name, price, description, tags, stock, active)
    values
      -- Pizzas: los TAMAÑOS son los productos con precio (el sabor se elige aparte)
      (v_id, 'Pizza Personal', 2.75,  'Pizza individual. Elige tu sabor.', array['pizzas'], 'disponible', true),
      (v_id, 'Pizza Mediana',  7.00,  'Pizza mediana. Elige tu sabor.',    array['pizzas'], 'disponible', true),
      (v_id, 'Pizza Familiar', 10.50, 'Pizza familiar. Elige tu sabor.',   array['pizzas'], 'disponible', true),
      (v_id, 'Pizza Gigante',  13.50, 'Pizza gigante. Elige tu sabor.',    array['pizzas'], 'disponible', true),
      (v_id, 'Pizza Monster',  16.00, 'La más grande. Elige tu sabor.',    array['pizzas'], 'disponible', true),

      -- Hamburguesas
      (v_id, 'Cheese Burguer',       3.50, 'Blend especial de la casa, vegetales frescos y quesos artesanales.', array['hamburguesas'], 'disponible', true),
      (v_id, 'Doble Cheese Burguer', 4.50, 'Doble carne y doble queso.', array['hamburguesas'], 'disponible', true),

      -- Platos
      (v_id, 'Nachos Super',     3.50, 'Nachos con todo.', array['platos'], 'disponible', true),
      (v_id, 'Nachos con Queso', 2.50, 'Nachos con queso.', array['platos'], 'disponible', true),

      -- Bebidas
      (v_id, 'Cola 1 Litro',  1.50, null, array['bebidas'], 'disponible', true),
      (v_id, 'Cola Mediana',  0.75, null, array['bebidas'], 'disponible', true),
      (v_id, 'Cola 3 Litros', 3.50, null, array['bebidas'], 'disponible', true),
      (v_id, 'Agua',          0.60, null, array['bebidas'], 'disponible', true),
      (v_id, 'Fuzetea',       1.00, null, array['bebidas'], 'disponible', true),
      (v_id, 'Cerveza',       1.50, null, array['bebidas'], 'disponible', true);
    raise notice 'Productos cargados para Monster Pizza (%).', v_id;
  else
    raise notice 'El negocio ya tiene productos; no se tocaron.';
  end if;

  -- ── Sabores de pizza (modificadores con ingredientes) ──
  insert into public.menu_modifiers (business_id, category_tag, group_label, name, description, sort)
  values
    (v_id, 'pizzas', 'Sabor', 'Romana',       'Pepperoni, tomate, pimiento y aceitunas', 1),
    (v_id, 'pizzas', 'Sabor', 'Mexicana',     'Salami, jalapeño, cheddar y salchicha', 2),
    (v_id, 'pizzas', 'Sabor', 'Ranchera',     'Jamón, champiñones y choclo', 3),
    (v_id, 'pizzas', 'Sabor', 'Mediterránea', 'Jamón, champiñones, tomate, pimiento y aceitunas', 4),
    (v_id, 'pizzas', 'Sabor', 'Italiana',     'Pepperoni, salami, champiñones, pimiento y aceitunas', 5),
    (v_id, 'pizzas', 'Sabor', 'Enchilada',    'Nachos, embutidos y jalapeño', 6),
    (v_id, 'pizzas', 'Sabor', 'Desgranada',   'Choclo y queso cheddar', 7),
    (v_id, 'pizzas', 'Sabor', 'Alemana',      'Salchicha, choclo y cebolla', 8),
    (v_id, 'pizzas', 'Sabor', 'Jardinera',    'Tomate, choclo, pimiento y aceitunas', 9),
    (v_id, 'pizzas', 'Sabor', 'Vegetariana',  'Champiñones, tomate, cebolla y pimiento', 10),
    (v_id, 'pizzas', 'Sabor', 'Hawaiana',     'Jamón y piña', 11),
    (v_id, 'pizzas', 'Sabor', 'Monster',      'Pepperoni, carne y champiñones', 12),
    (v_id, 'pizzas', 'Sabor', 'Peperonni',    'Abundante pepperoni', 13),
    (v_id, 'pizzas', 'Sabor', 'Americana',    'Jamón y champiñones', 14),
    (v_id, 'pizzas', 'Sabor', 'Cheese Burguer','Carne, cebolla, pimiento y cheddar', 15),
    (v_id, 'pizzas', 'Sabor', 'Carnívora',    'Embutidos', 16),
    (v_id, 'pizzas', 'Sabor', 'Criolla',      'Embutidos y choclo', 17),
    (v_id, 'pizzas', 'Sabor', 'Suiza',        'Pepperoni, jamón y salchicha', 18),
    (v_id, 'pizzas', 'Sabor', 'Azteca',       'Nachos, carne y tomate', 19)
  on conflict (business_id, category_tag, lower(name)) do nothing;
  raise notice 'Sabores de pizza cargados.';
end $$;

-- Verificación (opcional):
-- select name, price, tags from public.products
--   where business_id = (select id from public.businesses where lower(name)=lower('Monster Pizza') limit 1)
--   order by tags, price;
-- select name, description from public.menu_modifiers
--   where business_id = (select id from public.businesses where lower(name)=lower('Monster Pizza') limit 1)
--   order by sort;

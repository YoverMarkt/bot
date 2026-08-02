-- ============================================================================
-- GUARDIÁN DE FRONTERAS ENTRE NEGOCIOS
--
-- Responde la pregunta que ninguna otra comprobación responde:
-- ¿hay alguna tabla desde la que se pueda apuntar al dato de OTRO negocio?
--
-- El patrón: una tabla con `business_id` tiene una foránea hacia otra tabla
-- que TAMBIÉN tiene `business_id`, pero la foránea solo mira el id. Entonces
-- comprueba "esa fila existe", no "esa fila es de este negocio". Como el
-- negocio sale del JWT y el otro id viaja en la petición, ahí se cruza la
-- frontera mandando un uuid ajeno.
--
-- Así estuvieron `product_variants.product_id` y `products.category_id` hasta
-- el 2026-08-02. No los vio nadie durante meses porque no había ninguna ruta
-- que escribiera esas tablas: el agujero existía, pero no había puerta. En
-- cuanto se construyó la puerta, se volvió real.
--
-- ⚠️ Ese es el punto de este archivo. Antes la protección se ponía caso por
-- caso y NADA comprobaba el caso siguiente. Añade mañana una tabla con este
-- patrón y el CI te para hasta que decidas cómo se cierra.
--
-- Cerrarlo tiene dos formas válidas, y las dos se aceptan aquí:
--   1. Foránea COMPUESTA sobre (id, business_id) — lo impide la base.
--   2. La escritura pasa por una RPC que comprueba pertenencia y lanza 42501.
--      Entonces se anota abajo, con el nombre de la función que lo hace.
-- ============================================================================

\set ON_ERROR_STOP on

do $$
declare
  v_fila record;
  v_pendientes text := '';
  v_total integer := 0;
begin
  for v_fila in
    select
      con.conrelid::regclass::text as origen,
      (select string_agg(a.attname, ',' order by a.attnum)
         from unnest(con.conkey) k
         join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k) as columnas,
      con.confrelid::regclass::text as destino
    from pg_constraint con
    where con.contype = 'f'
      and con.connamespace = 'public'::regnamespace
      -- Apuntar a `businesses` es lo normal: ahí está el dueño del dato.
      and con.confrelid <> 'public.businesses'::regclass
      -- El origen pertenece a un negocio…
      and exists (select 1 from pg_attribute a
          where a.attrelid = con.conrelid and a.attname = 'business_id' and a.attnum > 0)
      -- …y el destino también.
      and exists (select 1 from pg_attribute a
          where a.attrelid = con.confrelid and a.attname = 'business_id' and a.attnum > 0)
      -- Pero `business_id` NO entra en la pareja: ahí está el agujero.
      and not exists (select 1 from unnest(con.conkey) k
          join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k
          where a.attname = 'business_id')
  loop
    -- ── Cerrados por una RPC que comprueba pertenencia (42501) ──────────────
    -- Cada línea dice QUIÉN lo cierra. Si la RPC deja de comprobarlo, lo caza
    -- `verificar-aislamiento.sql`, que ejecuta el intento con dos negocios
    -- reales. Este guardián vigila la FORMA; aquel, el COMPORTAMIENTO.
    if (v_fila.origen, v_fila.columnas) in (
      -- create_order_with_items: revalida negocio, producto, stock y precio.
      ('order_items', 'order_id'),
      ('order_items', 'product_id'),
      ('order_items', 'variant_id'),
      -- create_sale_with_items: mismo control para la venta manual.
      ('sale_items', 'sale_id'),
      ('sale_items', 'product_id'),
      -- create_storefront_order: 'La direccion no pertenece a este cliente'.
      ('orders', 'address_id'),
      -- El vendedor sale del JWT, nunca del cuerpo de la petición.
      ('sales', 'created_by'),
      -- Cuota mensual: la escribe la propia facturación, no llega de fuera.
      ('billing_month_claims', 'billing_id'),
      -- El bot registra consultas con productos de SU catálogo, ya resuelto.
      ('product_consultations', 'product_id'),
      -- ⚠️ `menu_modifiers.product_id` es el caso hermano de las variantes:
      -- hoy es inalcanzable porque el saneador de su ruta NO deja pasar
      -- product_id, así que ninguna petición puede fijarlo. Si algún día se
      -- añade al saneador, hay que cerrarlo antes con una foránea compuesta.
      ('menu_modifiers', 'product_id')
    ) then
      continue;
    end if;

    v_total := v_total + 1;
    v_pendientes := v_pendientes || format(
      E'\n    · %s(%s) → %s', v_fila.origen, v_fila.columnas, v_fila.destino
    );
  end loop;

  if v_total > 0 then
    raise exception E'FRONTERA SIN CERRAR entre negocios (% caso(s)):%\n\n%',
      v_total, v_pendientes,
      E'  Desde esa tabla se puede apuntar a la fila de OTRO negocio.\n'
      '  Ciérralo con una foránea compuesta sobre (id, business_id), como\n'
      '  product_variants, o con una RPC que compruebe pertenencia y lance\n'
      '  42501 — y en ese caso anótalo en verificar-fronteras.sql diciendo\n'
      '  qué función lo cierra.';
  end if;

  raise notice 'FRONTERAS ENTRE NEGOCIOS: ninguna quedó sin cerrar';
end;
$$;

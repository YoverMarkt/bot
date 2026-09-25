-- ============================================================================
-- LA CARTA DEL LOCAL: EL ALTA CARGA LO QUE LA IA LEYÓ Y UNA PERSONA REVISÓ
--
-- Pedido del dueño (2026-09-24): subir el menú de los locales que venda sin
-- teclearlo producto a producto. Se sube la foto de la carta en el SUPERADMIN,
-- al dar de alta el local; la IA propone, el dueño de Umbani revisa y corrige,
-- y lo revisado entra aquí. «Lo mejor, al momento de dar de alta un local»:
-- la carta ocupa el lugar de los productos de ejemplo del tipo.
--
-- ── POR QUÉ UNA FUNCIÓN NUEVA Y NO TOCAR `apply_business_template` ─────────
--
-- La de plantillas es el alta de TODOS los locales, y el alta ya se rompió
-- una vez sin que nadie lo viera (2026-08-02). Esta la usa por dentro, sin
-- cambiarle una línea, y añade las dos cosas que separan una carta de un
-- ejemplo:
--
--   1. PRECIOS DE VERDAD. La plantilla deja sus productos AGOTADOS porque su
--      precio es inventado. Los de la carta los leyó la IA de lo impreso y los
--      revisó una persona: nacen DISPONIBLES. La tienda del local nace apagada
--      igual, así que nada se vende antes de que el local esté listo.
--   2. TAMAÑOS. «Personal $5.99 · mediana $11.99» son variantes con su propio
--      precio (`product_variants`), y la plantilla no sabe de ellas.
--
-- ── ⚠️ EL PORTÓN ES LO QUE HACE SEGURO EL PASO 1 ────────────────────────────
--
-- `apply_business_template` no toca un negocio que ya tenga catálogo. Así que
-- si aplica, TODO producto del negocio salió de esta carta, y ponerlos a la
-- venta no puede alcanzar nada que el local ya tuviera. Si no aplica, aquí no
-- se toca nada: se devuelve su respuesta tal cual.
--
-- ── LO QUE LA CARTA NO TRAE, A PROPÓSITO ────────────────────────────────────
--
-- La IA lee lo IMPRESO, no inventa las REGLAS: qué parte del plato se vende
-- suelta, qué acompañante va gratis, mínimos y máximos. Esas las decide el
-- dueño en el panel. Las listas impresas (sopas, segundos, bebidas) entran
-- como grupos que el servidor arma antes de llegar aquí.
-- ============================================================================

create or replace function public.apply_business_menu(
  p_business_id uuid,
  p_menu jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_resultado jsonb;
  v_categoria jsonb;
  v_producto jsonb;
  v_variante jsonb;
  v_producto_id uuid;
  v_variantes integer := 0;
begin
  -- ── 0. Nombres únicos: es lo que enlaza cada tamaño con SU producto ──────
  -- Dos «Pizzas» en la carta, o dos «Hawaiana» dentro de la misma, dejarían
  -- un tamaño colgado del producto equivocado. El panel ya lo avisa; esto
  -- impide que llegue aunque alguien se salte el panel.
  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_menu->'categorias', '[]'::jsonb)) c
    group by lower(btrim(c->>'nombre'))
    having count(*) > 1
  ) then
    raise exception 'La carta repite una categoría' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_menu->'categorias', '[]'::jsonb))
           with ordinality c(categoria, n),
         jsonb_array_elements(coalesce(c.categoria->'productos', '[]'::jsonb)) p
    group by c.n, lower(btrim(p->>'nombre'))
    having count(*) > 1
  ) then
    raise exception 'La carta repite un producto dentro de una categoría'
      using errcode = '22023';
  end if;

  -- ── 1. El mismo motor que el alta, con su portón ─────────────────────────
  v_resultado := public.apply_business_template(p_business_id, p_menu);
  if (v_resultado->>'aplicada')::boolean is not true then
    return v_resultado;
  end if;

  -- ── 2. Precios de verdad: a la venta (ver la cabecera) ───────────────────
  update products set stock = 'disponible'
  where business_id = p_business_id;

  -- ── 3. Los tamaños, colgados de su producto ──────────────────────────────
  for v_categoria in
    select * from jsonb_array_elements(coalesce(p_menu->'categorias', '[]'::jsonb))
  loop
    for v_producto in
      select * from jsonb_array_elements(coalesce(v_categoria->'productos', '[]'::jsonb))
    loop
      if jsonb_array_length(coalesce(v_producto->'variantes', '[]'::jsonb)) = 0 then
        continue;
      end if;

      select p.id into strict v_producto_id
      from products p
      join product_categories c on c.id = p.category_id
      where p.business_id = p_business_id
        and c.business_id = p_business_id
        and lower(btrim(c.name)) = lower(btrim(v_categoria->>'nombre'))
        and lower(btrim(p.name)) = lower(btrim(v_producto->>'nombre'));

      for v_variante in
        select * from jsonb_array_elements(v_producto->'variantes')
      loop
        insert into product_variants (business_id, product_id, name, price, sort)
        values (
          p_business_id,
          v_producto_id,
          v_variante->>'nombre',
          (v_variante->>'precio')::numeric,
          coalesce((v_variante->>'orden')::integer, 0)
        );
        v_variantes := v_variantes + 1;
      end loop;
    end loop;
  end loop;

  return v_resultado || jsonb_build_object('variantes', v_variantes);
end;
$$;

revoke all on function public.apply_business_menu(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_business_menu(uuid, jsonb)
  to service_role;

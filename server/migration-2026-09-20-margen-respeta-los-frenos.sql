-- ============================================================================
-- EL MARGEN POR LÍNEA TIENE QUE RESPETAR EL TECHO Y EL PISO DE LA REGLA
--
-- Hallado auditando el núcleo de dinero el 2026-09-20, y REPRODUCIDO contra
-- PostgreSQL real antes de escribir una línea de arreglo.
--
-- ── EL FALLO ────────────────────────────────────────────────────────────────
--
-- `orders_stamp_pricing`, con modo `on_top` y estrategia `percentage`,
-- DESCARTA el margen que `calculate_platform_markup` ya había recortado y lo
-- sustituye por el de `order_markup_by_line`. Esa función suma el margen de
-- cada línea y NO aplica `min_amount` ni `max_amount`.
--
-- Medido, 10 × $5 = $50 con una regla `on_top` al 10 % y TECHO de $1:
--
--     la regla dice .......................... $1.00
--     la app le enseña al cliente (quoteCart)   total $51.00
--     la base cobraba ........................ $5.00  →  total $55.00
--
-- Y al revés, con PISO de $3 sobre un pedido de $5: la regla dice $3.00 y se
-- cobraban $0.50. Falla en las dos direcciones — contra el cliente y contra la
-- plataforma.
--
-- ── POR QUÉ ESTE ARREGLO Y NO OTRO ──────────────────────────────────────────
--
-- Un techo o un piso son cantidades del PEDIDO ENTERO, no del producto.
-- Repartirlos por línea daría un precio unitario que no existe. Las otras dos
-- capas ya lo tratan así desde el principio:
--
--   · `precioDeVitrina`  no pinta margen si la regla tiene topes
--     («cualquier regla con min_amount/max_amount son cantidades del PEDIDO
--       ENTERO: repartirlas por producto daría un precio unitario que no
--       existe»);
--   · `quoteCart`        excluye esas reglas del cálculo por línea
--     (`regla.minAmount == null && regla.maxAmount == null`).
--
-- El servidor era la ÚNICA capa que no hacía la excepción. Así que no se toca
-- el TypeScript: estaba en lo cierto. Se alinea la base con él.
--
-- ⚠️ NO se toca `order_markup_by_line`: sigue haciendo exactamente lo que dice
-- su nombre, y su aritmética —redondear el margen del precio unitario y
-- multiplicar por la cantidad— es la que replica `quoteCart` y la que hace que
-- el total coincida con lo que el cliente sumó en pantalla. Lo que cambia es
-- CUÁNDO se la llama.
--
-- ⚠️ Tampoco se recrean `create_storefront_order` ni `set_order_status`, igual
-- que en las migraciones anteriores del motor de margen.
--
-- ── QUÉ NO CAMBIA ───────────────────────────────────────────────────────────
--
-- Una regla SIN frenos (la única activa en producción hoy: `global`, 10 %,
-- `on_top`, sin techo ni piso) sigue sellando exactamente lo mismo por línea.
-- Comprobado contra los 10 últimos pedidos con margen: ninguno cambia.
--
-- Los pedidos ya sellados tampoco se tocan: esta migración no escribe en
-- `orders`.
-- ============================================================================

create or replace function public.orders_stamp_pricing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_calc     jsonb;
  v_base     numeric(10,2);
  v_modo     text;
  v_pct      numeric;
  v_piso     numeric;
  v_techo    numeric;
  v_markup   numeric(10,2);
  v_porlinea numeric(10,2);
  v_envio    numeric(10,2);
begin
  -- Lo que el comercio cobra POR LOS PRODUCTOS: sin envío, sin propina.
  v_base := round(coalesce(new.subtotal, 0) - coalesce(new.discount, 0), 2);

  if v_base <= 0 then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and new.subtotal is not distinct from old.subtotal
     and new.discount is not distinct from old.discount
     and new.pricing_rule_id is not distinct from old.pricing_rule_id then
    return new;
  end if;

  v_calc := public.calculate_platform_markup(new.business_id, v_base, new.pricing_rule_id);
  v_markup := (v_calc ->> 'markup')::numeric;
  v_modo := coalesce(v_calc ->> 'markup_mode', 'absorbed');

  -- Con `on_top` el precio se muestra por producto, así que el margen se
  -- calcula por línea o el total no coincidiría con lo que el cliente sumó.
  -- Si el pedido aún no tiene líneas (bot y mostrador) se queda el del
  -- subtotal: en esos caminos nunca se mostró un precio unitario con margen.
  if v_modo = 'on_top' and (v_calc ->> 'strategy') = 'percentage' then
    select percentage, min_amount, max_amount
      into v_pct, v_piso, v_techo
    from public.pricing_rules
    where id = nullif(v_calc ->> 'rule_id', '')::uuid;

    -- ⚠️ SOLO por línea cuando la regla no tiene frenos de PEDIDO.
    --
    -- Un techo o un piso no son del producto, son del pedido entero: con un
    -- techo de $1 el reparto por línea cobraba $5 y se saltaba el freno. Y el
    -- cliente nunca vio ese número, porque ni el catálogo ni la cotización
    -- pintan margen por producto cuando la regla lleva topes.
    --
    -- Con frenos se queda el margen del subtotal, que es el que YA viene
    -- recortado por `calculate_platform_markup` y el que la app le enseñó.
    if v_piso is null and v_techo is null then
      v_porlinea := public.order_markup_by_line(new.id, coalesce(v_pct, 0));
      if v_porlinea is not null then
        v_markup := v_porlinea;
      end if;
    end if;
  end if;

  new.platform_markup      := v_markup;
  new.pricing_rule_id      := nullif(v_calc ->> 'rule_id', '')::uuid;
  new.pricing_rule_version := nullif(v_calc ->> 'rule_version', '')::integer;

  if v_modo = 'on_top' then
    -- El comercio conserva su precio ENTERO: es la promesa del modo.
    new.merchant_subtotal := v_base;
    -- Y el margen se suma a lo que paga el cliente. El envío se respeta tal
    -- como lo dejó la función del dinero.
    v_envio := round(coalesce(new.total, 0) - v_base, 2);
    if v_envio < 0 then v_envio := 0; end if;
    new.total := round(v_base + v_markup + v_envio, 2);
  else
    -- `absorbed`: el margen sale del precio del comercio y el cliente paga
    -- lo mismo. El total no se toca.
    new.merchant_subtotal := round(v_base - v_markup, 2);
  end if;

  return new;
end;
$$;

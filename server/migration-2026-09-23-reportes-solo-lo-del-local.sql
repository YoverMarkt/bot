-- ============================================================================
-- LOS REPORTES ENSEÑAN SOLO LO QUE RECIBE EL LOCAL
--
-- Dicho por el dueño el 2026-09-21: «sobre los reportes, claro, tiene que ir
-- solo lo que el dueño recibe, no con mi margen de ganancia». Y antes, sobre
-- la carrera: «eso es del motorizado».
--
-- ── EL PROBLEMA ─────────────────────────────────────────────────────────────
--
-- `sales.total` es lo que pagó el CLIENTE, y todos los reportes lo suman: el
-- resumen, la comparativa, por vendedor, el top de clientes, el directorio y la
-- serie diaria. Con el margen `on_top` y la carrera dentro, «Total vendido» le
-- atribuye al local dos dineros que no son suyos.
--
-- Medido contra producción, Monster Pizza en agosto:
--
--     «Total vendido» que veía .......... $112.32
--     de comida vendió de verdad ........  $94.12
--     carreras (de quien entrega) .......  $16.00
--     comisión de la plataforma .........   $2.20
--
-- Son **$18.20 de diferencia** en un mes flojo. Ese es el número con el que el
-- dueño paga a su cocinero y decide si le dio el mes.
--
-- ── POR QUÉ SE CONGELA Y NO SE CRUZA ────────────────────────────────────────
--
-- La alternativa era unir `sales` con `orders` en cada consulta de reportes.
-- Se descarta por dos razones:
--
--   1. **Es lo que este proyecto hace con todo lo demás.** `order_items`
--      congela el nombre y el precio del producto, `orders` congela la
--      dirección, y `orders.pricing_rule_id` congela la regla. Una venta es un
--      hecho consumado: lo que se llevó la plataforma ESE día no puede cambiar
--      porque mañana se edite una regla.
--   2. Los reportes leen `sales` en ocho cuentas distintas. Una unión en cada
--      una es ocho oportunidades de olvidarse de una.
--
-- ⚠️ Se congelan las DOS partes ajenas —carrera y comisión— en vez de un solo
-- «lo que le queda». Con las dos, la venta se audita sola (total = productos +
-- carrera + comisión) y encaja con lo que ya devuelve
-- `platform_markup_summary`. Guardar solo el neto obligaría a restar hacia
-- atrás para saber de dónde salió.
--
-- ⚠️ NO se toca `sales.total`: sigue siendo lo que pagó el cliente, que es lo
-- que hay que comparar con un comprobante. Lo que se añade es de quién es cada
-- parte.
--
-- ── UN SOLO CAMINO CREA VENTAS ──────────────────────────────────────────────
--
-- `crear_venta_desde_pedido` es el único `insert into sales` que queda: las de
-- cita y estadía se fueron al reducir Umbani a domicilios. Eso hace que baste
-- con tocar una función.
-- ============================================================================

-- ── 1. Las dos partes que NO son del local ─────────────────────────────────
alter table public.sales
  add column if not exists shipping numeric(10,2) not null default 0;

alter table public.sales
  add column if not exists platform_markup numeric(10,2) not null default 0;

comment on column public.sales.shipping is
  'La carrera, congelada al vender. De quien entrega, no del local.';
comment on column public.sales.platform_markup is
  'Lo que se llevó la plataforma, congelado al vender. Ni del local ni de quien entrega.';

-- ── 2. Lo ya vendido se rellena desde su pedido ────────────────────────────
--
-- Sin esto los reportes seguirían inflados para todo lo anterior a hoy, que es
-- justo el histórico que el dueño mira. Una venta sin pedido —si algún día la
-- hubiera— se queda en 0, que es lo correcto: no hubo carrera ni comisión.
update public.sales s
   set shipping        = coalesce(o.shipping, 0),
       platform_markup = coalesce(o.platform_markup, 0)
  from public.orders o
 where o.id = s.order_id
   and (s.shipping is distinct from coalesce(o.shipping, 0)
        or s.platform_markup is distinct from coalesce(o.platform_markup, 0));

-- ── 3. Y las nuevas nacen con el reparto puesto ────────────────────────────
--
-- ⚠️ Es la MISMA función, con dos columnas más en el `insert`. No se recrea
-- nada de su lógica: las guardas de estado, el teléfono de mostrador y la
-- copia de `order_items` se conservan palabra por palabra.
create or replace function public.crear_venta_desde_pedido(
  p_business_id uuid,
  p_order_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_sale_id uuid;
begin
  select * into v_order
  from public.orders
  where id = p_order_id and business_id = p_business_id;
  if not found then
    return null;
  end if;

  select id into v_sale_id
  from public.sales
  where order_id = p_order_id and business_id = p_business_id;
  if found then
    return v_sale_id;
  end if;

  -- Solo cuenta lo entregado. Un pedido pendiente o cancelado no es dinero.
  -- Hoy quien decide es `set_order_status`, que solo llama aquí al pasar a
  -- 'completado' — pero esta función es SECURITY DEFINER y está concedida a
  -- service_role, así que un `db.rpc()` distraído facturaría un pedido
  -- cancelado. La misma guardia que ya tenía `crear_venta_desde_estadia`.
  if v_order.status is distinct from 'completado' then
    return null;
  end if;

  insert into public.sales (
    business_id, order_id, contact_phone, contact_name,
    total, shipping, platform_markup, status, source, sold_at
  ) values (
    p_business_id, p_order_id,
    -- 'mostrador' no es el teléfono de nadie: la venta va sin contacto.
    nullif(v_order.contact_phone, 'mostrador'),
    v_order.contact_name,
    -- `total` NO cambia: es lo que pagó el cliente. Lo que se añade al lado es
    -- de quién es cada parte, para que los reportes puedan enseñar solo la
    -- del local.
    v_order.total,
    coalesce(v_order.shipping, 0),
    coalesce(v_order.platform_markup, 0),
    'completada',
    case
      when v_order.source = 'storefront' then 'tienda'
      when v_order.source = 'manual' then 'mostrador'
      else 'bot'
    end,
    now()
  )
  returning id into v_sale_id;

  insert into public.sale_items (
    sale_id, business_id, product_id, product_name, quantity, unit_price, line_total
  )
  select
    v_sale_id, p_business_id, oi.product_id,
    oi.product_name || coalesce(' (' || oi.variant_name || ')', ''),
    oi.quantity, oi.unit_price, oi.line_total
  from public.order_items oi
  where oi.order_id = p_order_id and oi.business_id = p_business_id;

  return v_sale_id;
end;
$$;

revoke all on function public.crear_venta_desde_pedido(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.crear_venta_desde_pedido(uuid, uuid) to service_role;

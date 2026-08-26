-- ============================================================================
-- SE LEVANTA EL FRENO DE `on_top`: EL MARGEN SE SUMA AL PRECIO
--
-- Corrección del modelo económico pedida por el dueño el 2026-08-25.
--
-- HASTA HOY (`absorbed`), sobre un pedido de $8:
--   · el cliente pagaba          $8,00
--   · el comercio recibía        $7,20   ← se le descontaba el 10 %
--   · la plataforma se quedaba   $0,80
--
-- Los datos lo enseñan: en 5 pedidos los clientes pagaron $64,95 y el comercio
-- recibió $47,25. El dueño de un local pone el precio al que QUIERE VENDER;
-- quitarle una parte lo convierte en un descuento forzoso que no pactó.
--
-- DESDE HOY (`on_top`), sobre el mismo pedido:
--   · el comercio recibe         $8,00   ← su precio, entero
--   · la plataforma suma         $0,80
--   · el cliente paga            $8,80  (+ envío aparte)
--
-- ⚠️ ESTA MIGRACIÓN NO TOCA `orders_stamp_pricing`, Y ES DELIBERADO.
--
-- El disparador YA sabe hacer `on_top`, y mejor de lo que se iba a escribir en
-- esta migración: calcula el margen POR LÍNEA cuando la estrategia es
-- porcentual —para que el total coincida con lo que el cliente sumó en
-- pantalla— y resta el descuento de la base antes de aplicar el porcentaje.
-- La primera versión de este archivo lo reescribía y habría DEGRADADO las dos
-- cosas. Lo cazó el CI: `schema.sql` acumula tres redefiniciones de esa
-- función y manda la ÚLTIMA, así que leer solo la primera engaña.
--
-- Lo único que faltaba de verdad, comprobado contra producción:
--   1. el CHECK que impedía guardar `on_top`;
--   2. la vista que el catálogo necesita para pintar el precio con margen.
--
-- ⚠️ El CHECK estaba puesto a propósito, con esta nota: «`on_top` exige que el
-- catálogo, el carrito y el resumen pinten el precio con margen; hasta
-- entonces el CHECK lo impide». Se levanta ACOMPAÑADO de esos tres cambios,
-- así que la condición se cumple. No se levanta antes de tiempo.
--
-- ⚠️ LOS PEDIDOS VIEJOS NO CAMBIAN: `orders_stamp_pricing` recalcula con la
-- regla SELLADA en el pedido, no con la vigente hoy, y esto no toca ninguna
-- fila de `orders`. Los 5 pedidos ya cobrados siguen contando su margen
-- absorbido, que es lo que de verdad ocurrió.
-- ============================================================================

-- ── 1. `on_top` deja de estar prohibido ─────────────────────────────────────
alter table public.pricing_rules
  drop constraint if exists pricing_rules_mode_check;

alter table public.pricing_rules
  add constraint pricing_rules_mode_check
  check (markup_mode in ('absorbed', 'on_top'));

comment on column public.pricing_rules.markup_mode is
  '`on_top`: el margen se SUMA al precio y el comercio cobra entero. `absorbed`: se le descuenta. El modelo del negocio es `on_top` desde el 2026-08-25.';

-- ── 2. Qué margen pintar en el catálogo ─────────────────────────────────────
--
-- El catálogo tiene que enseñar el precio que el cliente va a pagar, y para eso
-- necesita el porcentaje vigente ANTES de que exista un pedido. Se devuelve la
-- regla entera —no un número suelto— para que el servidor aplique la MISMA
-- jerarquía (negocio → tipo → global) sin reimplementarla: dos jerarquías
-- acabarían dando dos respuestas a la misma pregunta, y una cobraría distinto.
--
-- ⚠️ Devuelve `null` si no hay regla vigente: entonces no se pinta margen y el
-- cliente ve el precio del comercio. Falla hacia NO cobrar de más, que es el
-- lado seguro del error.
create or replace function public.business_pricing_view(
  p_business_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_regla public.pricing_rules%rowtype;
begin
  if p_business_id is null then
    return null;
  end if;

  select pr.* into v_regla
  from public.pricing_rules pr
  join public.businesses b on b.id = p_business_id
  where pr.status = 'active'
    and pr.effective_from <= now()
    and (pr.effective_until is null or pr.effective_until > now())
    and (
      (pr.scope = 'business'      and pr.business_id = p_business_id)
      or (pr.scope = 'business_type' and pr.target_name = b.type)
      or (pr.scope = 'global')
    )
  order by case pr.scope
             when 'business'      then 1
             when 'business_type' then 2
             when 'global'        then 3
           end,
           pr.effective_from desc
  limit 1;

  if v_regla.id is null then
    return null;
  end if;

  return jsonb_build_object(
    'rule_id',      v_regla.id,
    'version',      v_regla.version,
    'mode',         v_regla.markup_mode,
    'strategy',     v_regla.strategy,
    'percentage',   v_regla.percentage,
    'fixed_amount', v_regla.fixed_amount,
    'tiers',        v_regla.tiers,
    'min_amount',   v_regla.min_amount,
    'max_amount',   v_regla.max_amount
  );
end;
$$;

revoke all on function public.business_pricing_view(uuid) from public, anon, authenticated;
grant execute on function public.business_pricing_view(uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- EL CIERRE DE MES: LA COMISIÓN ENTRA EN LA FACTURA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Última pieza para que la plataforma COBRE. Hasta ahora la comisión se
-- calculaba, se sellaba en cada pedido y se podía consultar acumulada — pero
-- no llegaba a ninguna factura. El SaaS seguía cobrando solo la cuota.
--
-- ── PENSADO PARA MUCHOS NEGOCIOS, NO PARA UNO ─────────────────────────────
--
-- Con un local cualquier cosa funciona. Con los miles de una ciudad grande,
-- tres decisiones dejan de ser opinables:
--
--   1. **El cierre es UNA operación por conjuntos, no un bucle.** Un
--      `for negocio in ... loop` haría una consulta por local: con 5.000
--      locales son 5.000 idas y vueltas y un cierre que tarda minutos y se
--      cae a la mitad. Aquí es un solo `insert ... select ... on conflict`,
--      una pasada, todo o nada.
--   2. **Índices para el rango de fechas.** `idx_sales_biz_date` empieza por
--      `business_id`, así que no sirve para «todas las ventas de agosto»:
--      PostgreSQL leería la tabla entera. El índice nuevo va por `sold_at` y
--      solo sobre las ventas completadas, que son las únicas que se cobran.
--   3. **Idempotente por naturaleza.** No suma: RECALCULA desde `sales` y
--      escribe el valor absoluto. Correr el cierre dos veces —o cinco— deja
--      el mismo número. Es la única forma de que un reintento tras un fallo
--      de red no cobre el doble.
--
-- ── LO QUE NO TOCA, Y POR QUÉ ─────────────────────────────────────────────
--
-- ⚠️ **Un mes ya PAGADO no se reescribe jamás.** Es la decisión del
-- 2026-08-15: si una venta se anula después de liquidar, se descuenta del mes
-- SIGUIENTE, no se corrige hacia atrás. Un número que el comercio ya vio y
-- pagó no puede cambiar bajo sus pies, y una factura emitida es un hecho.
--
-- ⚠️ `billing.amount` sigue siendo LA CUOTA y no se toca. La comisión va en
-- su propia columna: sumarla a `amount` rompería toda lectura existente y
-- dejaría al comercio sin poder distinguir qué paga por el servicio y qué por
-- sus ventas. El total es la suma de las dos.
--
-- ⚠️ Un negocio puede tener comisión y NO tener factura de ese mes: el alta
-- solo crea la cuota si hay `monthly_rate`. Sin el `insert`, la comisión de
-- esos locales desaparecería en silencio — justo el «dinero que se esfuma»
-- que el núcleo financiero existe para impedir.
--
-- ⚠️ Sin `begin`/`commit`: la transacción la abre el ejecutor.


-- ── 1. La comisión en la factura ───────────────────────────────────────────
alter table public.billing
  add column if not exists commission_amount    numeric(10,2) not null default 0,
  add column if not exists commission_orders    integer       not null default 0,
  add column if not exists commission_closed_at timestamptz;

comment on column public.billing.commission_amount is
  'Comisión de la plataforma del periodo. `amount` sigue siendo la cuota: el total es la suma.';


-- ── 2. Una factura por negocio y mes, declarado ────────────────────────────
--
-- La invariante ya existía —`billing_month_claims` tiene esa clave primaria—
-- pero `billing` no la declaraba, así que ningún camino futuro estaba
-- obligado a respetarla. Declararla permite además cerrar el mes con
-- `on conflict`, en UNA operación atómica en vez de leer-y-luego-escribir,
-- que con dos instancias del servidor es una carrera.
--
-- Verificado antes de crearlo: cero duplicados en los datos actuales.
create unique index if not exists uq_billing_negocio_periodo
  on public.billing (business_id, period_start);


-- ── 3. El índice que hace posible el cierre ────────────────────────────────
--
-- El cierre pregunta «todas las ventas completadas de este mes, de TODOS los
-- negocios». `idx_sales_biz_date` empieza por `business_id` y no sirve para
-- eso. Parcial sobre `completada` porque las anuladas no se cobran: el índice
-- queda más pequeño y más rápido.
create index if not exists idx_sales_cierre
  on public.sales (sold_at)
  where status = 'completada';

-- El cruce del cierre contra la factura del periodo.
create index if not exists idx_billing_periodo
  on public.billing (period_start);


-- ── 4. El cierre ───────────────────────────────────────────────────────────
--
-- Devuelve qué hizo, para que la tarea programada pueda registrarlo y el
-- superadmin vea el resultado sin abrir la base.
create or replace function public.settle_month_commission(
  p_period_start date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fin       date;
  v_afectadas integer;
  v_total     numeric(10,2);
  v_pagadas   integer;
begin
  if p_period_start is null or p_period_start <> date_trunc('month', p_period_start)::date then
    raise exception using
      errcode = '22023',
      message = 'El cierre va sobre el primer día de un mes.';
  end if;

  v_fin := (p_period_start + interval '1 month')::date;

  -- Cuántas facturas de ese mes están pagadas y por tanto NO se tocan. Se
  -- cuenta ANTES de escribir para poder informarlo: si un mes se cierra tarde
  -- y ya se cobró, el superadmin tiene que enterarse en vez de creer que
  -- entró todo.
  select count(*) into v_pagadas
  from public.billing
  where period_start = p_period_start
    and status = 'paid'
    and exists (
      select 1 from public.platform_markup_summary(p_period_start, v_fin, business_id)
    );

  -- UNA operación: calcula, actualiza lo que existe y crea lo que falta.
  --
  -- `insert ... on conflict do update` en vez de leer-y-escribir porque con
  -- dos instancias del servidor lo segundo es una carrera: las dos leerían
  -- «no hay factura» y las dos insertarían.
  with resumen as (
    select * from public.platform_markup_summary(p_period_start, v_fin, null)
  )
  insert into public.billing (
    business_id, amount, currency, period_start, period_end,
    status, commission_amount, commission_orders, commission_closed_at
  )
  select
    r.business_id,
    -- Sin cuota conocida la factura nace en 0 y solo lleva comisión: es
    -- preferible a que la comisión de ese local no se facture nunca.
    coalesce(b.monthly_rate, 0),
    'USD',
    p_period_start,
    (v_fin - interval '1 day')::date,
    'pending',
    r.margen,
    r.pedidos,
    now()
  from resumen r
  join public.businesses b on b.id = r.business_id
  on conflict (business_id, period_start) do update
  set commission_amount    = excluded.commission_amount,
      commission_orders    = excluded.commission_orders,
      commission_closed_at = now()
  -- ⚠️ Un mes ya pagado NO se reescribe: si una venta se anula después de
  -- liquidar, se descuenta del mes siguiente. Una factura emitida es un hecho.
  where public.billing.status <> 'paid';

  get diagnostics v_afectadas = row_count;

  select coalesce(sum(commission_amount), 0) into v_total
  from public.billing
  where period_start = p_period_start;

  return jsonb_build_object(
    'periodo',            p_period_start,
    'facturas_afectadas', v_afectadas,
    'comision_total',     v_total,
    'ya_pagadas',         v_pagadas
  );
end;
$$;

revoke all on function public.settle_month_commission(date)
  from public, anon, authenticated;
grant execute on function public.settle_month_commission(date)
  to service_role;

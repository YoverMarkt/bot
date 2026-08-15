-- ═══════════════════════════════════════════════════════════════════════════
-- LO QUE SE ANULA DESPUÉS DE COBRAR SE DESCUENTA DEL MES SIGUIENTE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La decisión se tomó el 2026-08-15 y **no llegó al código**. El cierre de mes
-- ya respeta la mitad —un mes `paid` no se reescribe— pero la otra mitad
-- faltaba: nada arrastraba la diferencia hacia adelante.
--
-- Resultado hoy: si un comercio paga su factura de agosto y en septiembre se
-- anula una venta de agosto, **esa comisión se queda cobrada para siempre**.
-- El comercio pagó por una venta que no existió y no hay forma de devolvérselo.
--
-- No ha mordido a nadie porque todavía no hay ninguna regla de margen activa.
-- Por eso se arregla ahora: con cero comisiones cobrándose, esto es una
-- migración; con cien locales facturando, es dinero mal cobrado a cien
-- personas y una conversación con cada una.
--
-- ── POR QUÉ ARRASTRAR Y NO CORREGIR HACIA ATRÁS ───────────────────────────
--
-- Reescribir un mes ya pagado cambia un número que el comercio VIO y PAGÓ.
-- Una factura emitida es un hecho: si algo cambia después, se ajusta en la
-- siguiente, como hace cualquier contabilidad. Además, corregir hacia atrás
-- obligaría a que toda liquidación fuera reversible — y eso convierte cada
-- cierre en algo que nunca termina de estar cerrado.
--
-- ── CÓMO SE CALCULA, SIN INVENTAR NADA ────────────────────────────────────
--
-- El ajuste es la diferencia entre lo que se COBRÓ por un periodo y lo que ese
-- periodo vale HOY, mirando las ventas tal como están ahora:
--
--     ajuste = comisión_que_vale_hoy − comisión_que_se_cobró
--
-- Si una venta se anuló, el periodo vale menos y el ajuste sale NEGATIVO: es
-- un descuento. Si apareciera una venta tardía de un mes cerrado, saldría
-- positivo y se cobraría. Las dos direcciones con la misma resta.
--
-- ⚠️ Solo se arrastran los meses **ya pagados**. Los que siguen `pending` se
-- recalculan enteros en su propio cierre, que es más simple y más exacto:
-- arrastrarlos además los contaría dos veces.
--
-- ⚠️ Y el ajuste se **reclama**: `commission_adjusted_from` deja constancia de
-- qué periodo se saldó. Sin eso, cada corrida diaria del cierre volvería a
-- arrastrar la misma diferencia y el descuento se aplicaría una y otra vez.
-- Es el mismo patrón que `orders.customer_notified_status`: se reclama en el
-- propio `update`, no se consulta antes.
--
-- ⚠️ Sin `begin`/`commit`: la transacción la abre el ejecutor.


-- ── 1. De dónde viene el ajuste ────────────────────────────────────────────
create table if not exists public.billing_adjustments (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,

  -- La factura donde se aplica el descuento (el mes siguiente).
  billing_id    uuid references public.billing(id) on delete set null,

  -- El periodo que se está corrigiendo (el mes ya pagado).
  source_period date not null,

  amount        numeric(10,2) not null,
  reason        text not null,
  created_at    timestamptz not null default now(),

  -- Un periodo se salda UNA vez por negocio. Es lo que impide que el cierre
  -- diario aplique el mismo descuento treinta veces.
  constraint billing_adjustments_unicos unique (business_id, source_period),

  constraint billing_adjustments_reason_check
    check (reason in ('venta_anulada', 'venta_tardia', 'correccion_manual')),
  constraint billing_adjustments_amount_check
    check (amount <> 0 and amount between -99999 and 99999)
);

alter table public.billing_adjustments enable row level security;

create index if not exists idx_billing_adjustments_negocio
  on public.billing_adjustments (business_id, source_period);

-- Lo que la factura del mes lleva de arrastre, para poder enseñarlo aparte de
-- la comisión del propio mes. Sumarlo dentro de `commission_amount` haría
-- imposible explicarle al comercio de dónde sale su número.
alter table public.billing
  add column if not exists commission_adjustment numeric(10,2) not null default 0;

comment on column public.billing.commission_adjustment is
  'Ajuste arrastrado de meses ya pagados. Negativo = se le devuelve. El total es amount + commission_amount + commission_adjustment.';


-- ── 2. El arrastre ─────────────────────────────────────────────────────────
--
-- Mira los meses PAGADOS anteriores al que se está cerrando, compara lo
-- cobrado con lo que valen hoy, y aplica la diferencia UNA sola vez.
create or replace function public.carry_commission_adjustments(
  p_period_start date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_aplicados integer := 0;
  v_total     numeric(10,2) := 0;
  v_fila      record;
  v_vale_hoy  numeric(10,2);
  v_ajuste    numeric(10,2);
begin
  if p_period_start is null or p_period_start <> date_trunc('month', p_period_start)::date then
    raise exception using
      errcode = '22023',
      message = 'El arrastre va sobre el primer día de un mes.';
  end if;

  -- Solo meses PAGADOS y anteriores, y solo los que no se hayan saldado ya.
  for v_fila in
    select b.business_id, b.period_start, b.commission_amount
    from public.billing b
    where b.status = 'paid'
      and b.period_start < p_period_start
      and not exists (
        select 1 from public.billing_adjustments a
        where a.business_id = b.business_id
          and a.source_period = b.period_start
      )
  loop
    -- Lo que ese periodo vale HOY, con las ventas tal como están ahora.
    select coalesce(sum(margen), 0) into v_vale_hoy
    from public.platform_markup_summary(
      v_fila.period_start,
      (v_fila.period_start + interval '1 month')::date,
      v_fila.business_id
    );

    v_ajuste := round(v_vale_hoy - coalesce(v_fila.commission_amount, 0), 2);

    -- Sin diferencia no se anota nada: una fila de ajuste con importe cero es
    -- ruido, y además marcaría el periodo como saldado cuando aún podría
    -- cambiar.
    continue when v_ajuste = 0;

    insert into public.billing_adjustments (
      business_id, source_period, amount, reason
    ) values (
      v_fila.business_id,
      v_fila.period_start,
      v_ajuste,
      case when v_ajuste < 0 then 'venta_anulada' else 'venta_tardia' end
    )
    on conflict (business_id, source_period) do nothing;

    v_aplicados := v_aplicados + 1;
    v_total := v_total + v_ajuste;
  end loop;

  -- Se vuelca sobre la factura del mes que se cierra. Se suma en vez de
  -- asignar porque puede arrastrar varios periodos a la vez.
  update public.billing b
  set commission_adjustment = coalesce(sub.suma, 0)
  from (
    select a.business_id, sum(a.amount) as suma
    from public.billing_adjustments a
    where a.billing_id is null
    group by a.business_id
  ) as sub
  where b.business_id = sub.business_id
    and b.period_start = p_period_start
    and b.status <> 'paid';

  -- Se marca a qué factura fueron, para que no se vuelquen otra vez mañana.
  update public.billing_adjustments a
  set billing_id = b.id
  from public.billing b
  where a.billing_id is null
    and b.business_id = a.business_id
    and b.period_start = p_period_start;

  return jsonb_build_object(
    'periodo',        p_period_start,
    'ajustes',        v_aplicados,
    'total_ajustado', v_total
  );
end;
$$;

revoke all on function public.carry_commission_adjustments(date)
  from public, anon, authenticated;
grant execute on function public.carry_commission_adjustments(date)
  to service_role;

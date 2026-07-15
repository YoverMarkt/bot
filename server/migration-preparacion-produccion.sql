-- Preparación para producción sin cobros automáticos.
-- Elimina únicamente infraestructura de enlaces/proveedores de pago, cambia
-- el ciclo de pedidos a entrega manual y garantiza horarios iniciales.
-- La migración es transaccional: cualquier hallazgo o error revierte todo.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

-- No se elimina información financiera accidentalmente. Si una instalación
-- llegó a usar estas columnas o tablas, la transacción se detiene para poder
-- exportar esos datos antes de retirarlos.
do $$
declare
  v_count bigint;
  v_column text;
  v_table text;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'businesses'
      and column_name = 'payment_link'
  ) then
    execute 'select count(*) from public.businesses where payment_link is not null'
      into v_count;
    if v_count > 0 then
      raise exception using errcode = '23514',
        message = 'Hay enlaces de pago guardados en businesses; expórtalos antes de continuar';
    end if;
  end if;

  for v_column in
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in ('payment_provider', 'payment_link', 'payment_ref', 'paid_at')
  loop
    execute format('select count(*) from public.orders where %I is not null', v_column)
      into v_count;
    if v_count > 0 then
      raise exception using errcode = '23514',
        message = format('Hay datos guardados en orders.%s; expórtalos antes de continuar', v_column);
    end if;
  end loop;

  foreach v_table in array array[
    'payment_provider_accounts',
    'payment_intents',
    'payment_attempts',
    'payment_transactions',
    'payment_webhook_events'
  ]
  loop
    if to_regclass(format('public.%I', v_table)) is not null then
      execute format('select count(*) from public.%I', v_table) into v_count;
      if v_count > 0 then
        raise exception using errcode = '23514',
          message = format('La tabla %s contiene datos; expórtalos antes de continuar', v_table);
      end if;
    end if;
  end loop;
end;
$$;

-- Funciones auxiliares que solamente existían para desbloquear recursos al
-- recibir un cobro. Las tablas se eliminan después y CASCADE retira cualquier
-- función adicional que dependa directamente de sus tipos.
drop function if exists public.create_booking_with_service_if_available(
  uuid, text, text, text, date, time, integer, text, uuid
);
drop function if exists public.set_booking_status_for_payment(uuid, uuid, text);
drop function if exists public.set_order_status_for_payment(uuid, uuid, text);

drop table if exists public.payment_webhook_events cascade;
drop table if exists public.payment_transactions cascade;
drop table if exists public.payment_attempts cascade;
drop table if exists public.payment_intents cascade;
drop table if exists public.payment_provider_accounts cascade;

alter table if exists public.businesses
  drop column if exists payment_link;

alter table if exists public.orders
  drop column if exists payment_provider,
  drop column if exists payment_link,
  drop column if exists payment_ref,
  drop column if exists paid_at,
  drop column if exists payment_status;

alter table if exists public.bookings
  drop column if exists payment_status;

alter table if exists public.sales
  drop column if exists payment_status;

alter table if exists public.lodging_requests
  drop column if exists payment_status;

-- El estado "pagado" pertenecía al flujo automático. Para la operación
-- manual se conserva el significado histórico como "completado".
alter table if exists public.orders
  drop constraint if exists orders_status_check;

update public.orders
set status = 'completado', updated_at = now()
where status = 'pagado';

alter table public.orders
  add constraint orders_status_check
  check (status in ('pendiente', 'confirmado', 'completado', 'cancelado', 'expirado'));

create or replace function public.set_order_status(
  p_business_id uuid,
  p_order_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
begin
  if p_status not in ('confirmado', 'completado', 'cancelado', 'expirado') then
    raise exception using errcode = '22023', message = 'Estado de pedido inválido';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id and business_id = p_business_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found', 'order', null);
  end if;

  if v_order.status = p_status then
    return jsonb_build_object('result', 'updated', 'order', to_jsonb(v_order));
  end if;

  if not (
    (v_order.status = 'pendiente' and p_status in ('confirmado', 'cancelado', 'expirado'))
    or (v_order.status = 'confirmado' and p_status in ('completado', 'cancelado', 'expirado'))
  ) then
    return jsonb_build_object('result', 'invalid_transition', 'order', to_jsonb(v_order));
  end if;

  update public.orders
  set status = p_status, updated_at = now()
  where id = p_order_id and business_id = p_business_id
  returning * into v_order;

  return jsonb_build_object('result', 'updated', 'order', to_jsonb(v_order));
end;
$$;

revoke all on function public.set_order_status(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_order_status(uuid, uuid, text)
  to service_role;

-- Horario inicial para negocios nuevos, incluso si se crean desde otra
-- integración, y relleno no destructivo para negocios existentes sin días.
create or replace function public.ensure_business_default_schedule()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.business_schedule (
    business_id, day_of_week, open_time, close_time, slot_duration, is_active
  ) values
    (new.id, 0, '09:00', '18:00', 60, false),
    (new.id, 1, '09:00', '18:00', 60, true),
    (new.id, 2, '09:00', '18:00', 60, true),
    (new.id, 3, '09:00', '18:00', 60, true),
    (new.id, 4, '09:00', '18:00', 60, true),
    (new.id, 5, '09:00', '18:00', 60, true),
    (new.id, 6, '09:00', '13:00', 60, true)
  on conflict (business_id, day_of_week) do nothing;
  return new;
end;
$$;

drop trigger if exists businesses_default_schedule on public.businesses;
create trigger businesses_default_schedule
after insert on public.businesses
for each row execute function public.ensure_business_default_schedule();

insert into public.business_schedule (
  business_id, day_of_week, open_time, close_time, slot_duration, is_active
)
select business.id, schedule.day_of_week, schedule.open_time, schedule.close_time,
       schedule.slot_duration, schedule.is_active
from public.businesses as business
cross join (
  values
    (0, '09:00'::time, '18:00'::time, 60, false),
    (1, '09:00'::time, '18:00'::time, 60, true),
    (2, '09:00'::time, '18:00'::time, 60, true),
    (3, '09:00'::time, '18:00'::time, 60, true),
    (4, '09:00'::time, '18:00'::time, 60, true),
    (5, '09:00'::time, '18:00'::time, 60, true),
    (6, '09:00'::time, '13:00'::time, 60, true)
) as schedule(day_of_week, open_time, close_time, slot_duration, is_active)
on conflict (business_id, day_of_week) do nothing;

revoke all on function public.ensure_business_default_schedule()
  from public, anon, authenticated;

commit;

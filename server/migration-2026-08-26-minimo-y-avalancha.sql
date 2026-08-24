-- ═══════════════════════════════════════════════════════════════════════════
-- MÍNIMO DE COMPRA Y TOPE DE PEDIDOS POR HORA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El freno del 2026-08-25 cuenta pedidos POR CLIENTE: tres abiertos y a la
-- cuarta se para. No cubre el caso de las cuarenta personas distintas.
--
-- El ejemplo real: alguien monta un grupo de WhatsApp con cuarenta contactos y
-- les pasa el enlace con «pidan una gaseosa, es gratis». Cada uno hace UN
-- pedido, así que ninguno pasa de tres y ninguno está bloqueado. A la cocina le
-- entran cuarenta comandas de $1,50 a la vez y suenan cuarenta alarmas.
--
-- Se frena por los dos lados, y son distintos a propósito:
--
--   · `min_order_amount` — lo que el local considera que vale la pena
--     preparar. Esos cuarenta pedidos ni se crean.
--   · `max_orders_per_hour` — cuántos puede ATENDER en una hora. Aunque cada
--     pedido sea legítimo, un local no puede recibir más de los que cocina.
--
-- ⚠️ El mínimo lo pone EL DUEÑO, según su producto más barato. La plataforma
-- no sabe si $5 es razonable: en una pizzería sobra y en una heladería cierra
-- el negocio. Nace en 0 —sin mínimo— para que ningún local existente cambie de
-- comportamiento sin haberlo pedido.
--
-- ⚠️ El mínimo se mide sobre `subtotal - discount`, **sin el envío**. Quien
-- quiera un agua de $0,50 y pagar $2 de reparto está en su derecho: lo que el
-- local decide es cuánto vale la pena COCINAR, no cuánto gasta el cliente.

alter table public.businesses
  -- 0 = sin mínimo, y es un cero natural, no un valor mágico.
  add column if not exists min_order_amount numeric(10,2) not null default 0,
  -- Sin «sin límite» a propósito: un campo que se puede dejar en infinito se
  -- queda en infinito, y entonces no protege a nadie. Quien necesite más, sube
  -- el número — está en su panel.
  add column if not exists max_orders_per_hour integer not null default 30;

alter table public.businesses
  drop constraint if exists businesses_frenos_check;
alter table public.businesses
  add constraint businesses_frenos_check check (
    min_order_amount >= 0 and min_order_amount <= 999
    and max_orders_per_hour >= 1 and max_orders_per_hour <= 500
  );


-- ── El mínimo de compra ────────────────────────────────────────────────────
--
-- ⚠️ Disparador, no dentro de `create_storefront_order`: la misma regla que ya
-- siguieron `orders_reject_blocked`, `orders_stamp_pricing` y
-- `orders_limit_open_per_customer`. La función del dinero no se recrea por un
-- añadido, y así cubre todos los caminos que creen pedidos.
--
-- ⚠️ `before insert` y DESPUÉS de que el importe esté puesto. `orders_stamp_pricing`
-- sella el margen en otro disparador `before insert`; PostgreSQL los ejecuta en
-- orden alfabético del nombre, y `orders_min_amount` va después de
-- `orders_limit_open_per_customer` y antes de `orders_reject_*`. Ninguno
-- depende del otro: este solo lee `new.subtotal`, que ya viene de la RPC.
create or replace function public.orders_enforce_min_amount()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_minimo numeric(10,2);
  v_base numeric(10,2);
begin
  -- Mostrador exento, igual que en los demás frenos: lo teclea el dueño con la
  -- persona delante, y si quiere venderle un chicle es su decisión.
  if coalesce(new.source, '') <> 'storefront' then
    return new;
  end if;

  select min_order_amount into v_minimo
  from public.businesses where id = new.business_id;

  if coalesce(v_minimo, 0) <= 0 then
    return new;
  end if;

  -- Sin el envío: lo que el local decide es cuánto vale la pena COCINAR.
  v_base := coalesce(new.subtotal, 0) - coalesce(new.discount, 0);

  if v_base < v_minimo then
    raise exception using
      errcode = '42501',
      message = format(
        'El pedido mínimo de este local es $%s y tu pedido suma $%s. Agrega algo más para completarlo.',
        to_char(v_minimo, 'FM999999990.00'),
        to_char(v_base, 'FM999999990.00')
      );
  end if;

  return new;
end;
$$;

drop trigger if exists orders_enforce_min_amount on public.orders;
create trigger orders_enforce_min_amount
  before insert on public.orders
  for each row execute function public.orders_enforce_min_amount();


-- ── El tope de pedidos por hora ────────────────────────────────────────────
--
-- ⚠️ Protege al LOCAL, no a la plataforma, y el texto lo dice: quien se topa
-- con esto es un cliente legítimo al que el local no puede atender ahora
-- mismo. Decirle «vuelve en unos minutos» es la verdad; decirle «error» sería
-- echarle a él la culpa de que el local esté lleno.
--
-- ⚠️ Cuenta TODOS los pedidos de la tienda de la última hora, en cualquier
-- estado. Un pedido cancelado también ocupó a alguien, y contarlos solo
-- «abiertos» dejaría el freno inútil justo cuando el dueño va cancelando la
-- avalancha a mano.
create or replace function public.orders_limit_per_hour()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tope integer;
  v_ultima_hora integer;
begin
  if coalesce(new.source, '') <> 'storefront' then
    return new;
  end if;

  select max_orders_per_hour into v_tope
  from public.businesses where id = new.business_id;

  -- Falla ABIERTO: un negocio sin el campo puesto —una fila de antes de esta
  -- migración, un `update` a mano— vende como siempre. Un problema de
  -- configuración no puede dejar a un local sin poder recibir pedidos.
  if v_tope is null or v_tope <= 0 then
    return new;
  end if;

  select count(*) into v_ultima_hora
  from public.orders as previo
  where previo.business_id = new.business_id
    and previo.source = 'storefront'
    and previo.created_at > now() - interval '1 hour';

  if v_ultima_hora >= v_tope then
    raise exception using
      errcode = '42501',
      message = 'Este local está recibiendo muchos pedidos ahora mismo. Intenta de nuevo en unos minutos.';
  end if;

  return new;
end;
$$;

drop trigger if exists orders_limit_per_hour on public.orders;
create trigger orders_limit_per_hour
  before insert on public.orders
  for each row execute function public.orders_limit_per_hour();

-- El disparador cuenta por (negocio, fecha) sobre los de la tienda. El índice
-- de `orders_limit_open_per_customer` empieza por (business_id, customer_id),
-- así que no sirve para contar sin cliente.
create index if not exists idx_orders_por_hora
  on public.orders (business_id, created_at)
  where source = 'storefront';

-- ═══════════════════════════════════════════════════════════════════════════
-- UNA CITA ATENDIDA ES UNA VENTA — el estándar llega a servicios
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El problema medido: `bookings` NO tenía precio, y no existía ni un vínculo
-- entre una cita y una venta. En una barbería o un consultorio el recorrido
-- era: el cliente reserva → le atienden → y alguien tiene que acordarse de ir
-- a «Registrar venta» y escribirla a mano. Si se olvida, esa atención no
-- existe en ningún reporte.
--
-- Con esto, servicios queda igual que restaurantes:
--
--   Pedido entregado  → venta          (ya hecho)
--   Cita ATENDIDA     → venta          (esto)
--
-- Tres decisiones y su porqué:
--
--  · El precio se CONGELA al agendar. Si mañana el corte sube de $10 a $12,
--    la cita de ayer sigue valiendo $10: es lo que se pactó con el cliente.
--
--  · La cita apunta al servicio del catálogo (`product_id`), que es donde ya
--    viven precio y duración. Así «lo más vendido» de una barbería funciona
--    igual que el de una pizzería, sin inventar un catálogo paralelo.
--
--  · «Atendida» es un estado NUEVO y distinto de «confirmada». Confirmar es
--    decir «te espero»; atender es que la persona vino. Solo lo segundo es
--    dinero, y por eso solo lo segundo genera venta.
--
-- Idempotente. Aplicar con `npm run migrate`.

-- ── 1. La cita sabe qué servicio es y cuánto vale ─────────────────────────
alter table public.bookings
  add column if not exists product_id uuid references public.products(id) on delete set null,
  add column if not exists price numeric(10,2);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bookings'::regclass and conname = 'bookings_precio_check'
  ) then
    alter table public.bookings add constraint bookings_precio_check check (
      price is null or (price >= 0 and price <= 99999)
    );
  end if;
end;
$$;

-- El servicio tiene que ser del MISMO negocio que la cita. Clave foránea
-- compuesta, como en el catálogo: que lo impida la base y no el que escriba
-- la próxima ruta.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bookings'::regclass and conname = 'fk_bookings_servicio_del_negocio'
  ) then
    alter table public.bookings
      add constraint fk_bookings_servicio_del_negocio
      foreign key (product_id, business_id)
      references public.products (id, business_id) on delete set null;
  end if;
end;
$$;

-- ── 2. «Atendida»: vino y se le atendió ───────────────────────────────────
alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check check (
  status in ('pending', 'confirmed', 'attended', 'cancelled', 'no_show')
);

-- ── 3. La venta sabe de qué cita salió ────────────────────────────────────
alter table public.sales
  add column if not exists booking_id uuid references public.bookings(id) on delete set null;

-- Una cita, una venta como máximo: lo mismo que protege a los pedidos de
-- duplicar dinero al marcar dos veces.
create unique index if not exists uq_sales_booking
  on public.sales (booking_id) where booking_id is not null;

-- ── 4. La conversión ──────────────────────────────────────────────────────
create or replace function public.crear_venta_desde_cita(
  p_business_id uuid,
  p_booking_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_booking public.bookings%rowtype;
  v_sale_id uuid;
  v_precio numeric(10,2);
  v_nombre text;
begin
  select * into v_booking
  from public.bookings
  where id = p_booking_id and business_id = p_business_id;
  if not found then
    return null;
  end if;

  select id into v_sale_id
  from public.sales
  where booking_id = p_booking_id and business_id = p_business_id;
  if found then
    return v_sale_id;
  end if;

  -- Sin precio no hay venta que registrar, y no es un error: una cita puede
  -- ser una consulta gratuita o el negocio puede cobrar aparte. Se atiende
  -- igual, simplemente no suma dinero.
  v_precio := coalesce(v_booking.price, 0);
  if v_precio <= 0 then
    return null;
  end if;

  v_nombre := coalesce(nullif(btrim(v_booking.service), ''), 'Servicio');

  insert into public.sales (
    business_id, booking_id, contact_phone, contact_name,
    total, status, source, sold_at
  ) values (
    p_business_id, p_booking_id, v_booking.contact_phone, v_booking.contact_name,
    v_precio, 'completada', 'cita', now()
  )
  returning id into v_sale_id;

  insert into public.sale_items (
    sale_id, business_id, product_id, product_name, quantity, unit_price, line_total
  ) values (
    v_sale_id, p_business_id, v_booking.product_id, v_nombre, 1, v_precio, v_precio
  );

  return v_sale_id;
end;
$$;

revoke all on function public.crear_venta_desde_cita(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.crear_venta_desde_cita(uuid, uuid) to service_role;

-- ── 5. Marcar atendida registra la venta, en una sola transacción ─────────
-- `p_price` existe porque la mayoría de las citas las agenda el BOT, y el bot
-- no pregunta precios. El dueño lo confirma al marcar «atendida», en la misma
-- llamada: si fuera un update aparte, una cita podría quedar atendida con el
-- precio a medio guardar.
create or replace function public.set_booking_status(
  p_business_id uuid,
  p_booking_id uuid,
  p_status text,
  p_price numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_booking public.bookings%rowtype;
begin
  if p_status not in ('pending', 'confirmed', 'attended', 'cancelled', 'no_show') then
    raise exception using errcode = '22023', message = 'Estado de cita inválido';
  end if;

  select * into v_booking
  from public.bookings
  where id = p_booking_id and business_id = p_business_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_booking.status = p_status then
    return jsonb_build_object('result', 'updated', 'booking', to_jsonb(v_booking));
  end if;

  -- Una cita cerrada no se reabre: se agenda otra. Igual que los pedidos, el
  -- camino va siempre hacia adelante para que el historial sea auditable.
  if v_booking.status in ('attended', 'cancelled', 'no_show') then
    return jsonb_build_object('result', 'invalid_transition', 'booking', to_jsonb(v_booking));
  end if;

  if p_price is not null and (p_price < 0 or p_price > 99999) then
    raise exception using errcode = '22023', message = 'El precio de la cita es inválido';
  end if;

  update public.bookings
  set status = p_status,
      price = coalesce(round(p_price, 2), price)
  where id = p_booking_id and business_id = p_business_id
  returning * into v_booking;

  if p_status = 'attended' then
    perform public.crear_venta_desde_cita(p_business_id, p_booking_id);
  end if;

  return jsonb_build_object('result', 'updated', 'booking', to_jsonb(v_booking));
end;
$$;

revoke all on function public.set_booking_status(uuid, uuid, text, numeric)
  from public, anon, authenticated;
grant execute on function public.set_booking_status(uuid, uuid, text, numeric) to service_role;

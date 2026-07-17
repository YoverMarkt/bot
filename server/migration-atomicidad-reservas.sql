-- Impide reservas activas solapadas, incluso bajo solicitudes concurrentes.
-- Este modelo protege la agenda simple actual: una sola reserva simultánea
-- por negocio. No modela habitaciones, mesas ni profesionales independientes.
-- Es idempotente y no elimina reservas existentes.

begin;

create extension if not exists btree_gist;

-- Fija la duración histórica para que el intervalo ocupado no cambie si luego
-- se modifica el horario del negocio.
update public.bookings as booking
set duration_minutes = coalesce(
  (
    select schedule.slot_duration
    from public.business_schedule as schedule
    where schedule.business_id = booking.business_id
      and schedule.day_of_week = extract(dow from booking.booking_date)::integer
    limit 1
  ),
  60
)
where booking.duration_minutes is null
   or booking.duration_minutes <= 0;

update public.bookings
set status = 'pending'
where status is null;

do $$
begin
  if exists (select 1 from public.bookings where business_id is null) then
    raise exception using
      errcode = '23502',
      message = 'Existen reservas sin negocio. Asígnales un business_id válido antes de ejecutar esta migración.';
  end if;
  if exists (select 1 from public.bookings where duration_minutes > 1440) then
    raise exception using
      errcode = '23514',
      message = 'Existen reservas con duración mayor a 1440 minutos. Corrígelas antes de ejecutar esta migración.';
  end if;
end;
$$;

alter table public.bookings
  alter column business_id set not null,
  alter column duration_minutes set default 60,
  alter column duration_minutes set not null,
  alter column status set default 'pending',
  alter column status set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.bookings'::regclass
      and conname = 'bookings_duration_minutes_check'
  ) then
    alter table public.bookings
      add constraint bookings_duration_minutes_check
      check (duration_minutes between 1 and 1440) not valid;
  end if;
end;
$$;

alter table public.bookings
  validate constraint bookings_duration_minutes_check;

-- Si ya existen cruces activos, no decide cuál cliente conservar: aborta con
-- un mensaje claro para que el dueño cancele el registro incorrecto primero.
do $$
begin
  if exists (
    select 1
    from public.bookings as first_booking
    join public.bookings as second_booking
      on second_booking.business_id = first_booking.business_id
     and second_booking.id > first_booking.id
     and second_booking.status in ('pending', 'confirmed')
     and tsrange(
       second_booking.booking_date + second_booking.booking_time,
       second_booking.booking_date + second_booking.booking_time
         + make_interval(mins => second_booking.duration_minutes),
       '[)'
     ) && tsrange(
       first_booking.booking_date + first_booking.booking_time,
       first_booking.booking_date + first_booking.booking_time
         + make_interval(mins => first_booking.duration_minutes),
       '[)'
     )
    where first_booking.status in ('pending', 'confirmed')
  ) then
    raise exception using
      errcode = '23P01',
      message = 'Existen reservas activas solapadas. Cancela el registro incorrecto y vuelve a ejecutar esta migración.';
  end if;
end;
$$;

-- Esta restricción es la garantía final: cubre RPC, concurrencia entre varias
-- instancias del servidor y cualquier escritura futura directa a la tabla.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.bookings'::regclass
      and conname = 'bookings_no_active_overlap'
  ) then
    alter table public.bookings
      add constraint bookings_no_active_overlap
      exclude using gist (
        business_id with =,
        tsrange(
          booking_date + booking_time,
          booking_date + booking_time
            + make_interval(mins => duration_minutes),
          '[)'
        ) with &&
      )
      where (status in ('pending', 'confirmed'));
  end if;
end;
$$;

create or replace function public.create_booking_if_available(
  p_business_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_service text,
  p_booking_date date,
  p_booking_time time,
  p_duration_minutes integer default null,
  p_notes text default null
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_booking public.bookings%rowtype;
  v_schedule public.business_schedule%rowtype;
  v_business_accepts_bookings boolean;
  v_duration integer;
  v_local_now timestamp := now() at time zone 'America/Guayaquil';
begin
  if p_business_id is null then
    raise exception using errcode = '22023', message = 'El negocio es obligatorio';
  end if;
  if nullif(btrim(p_contact_phone), '') is null then
    raise exception using errcode = '22023', message = 'El contacto es obligatorio';
  end if;
  if p_booking_date is null or p_booking_time is null then
    raise exception using errcode = '22023', message = 'La fecha y hora son obligatorias';
  end if;
  if p_booking_date + p_booking_time <= v_local_now then
    raise exception using errcode = '22023', message = 'La reserva debe estar en el futuro';
  end if;

  -- Serializa las decisiones del mismo negocio y día. El lock se libera solo
  -- al terminar la transacción y funciona entre procesos/instancias distintas.
  perform pg_advisory_xact_lock(
    hashtextextended(p_business_id::text || ':' || p_booking_date::text, 0)
  );

  select (
    business.takes_bookings is true
    and business.active is true
    and business.suspended is not true
  )
  into v_business_accepts_bookings
  from public.businesses as business
  where business.id = p_business_id
  for share;

  if not found then
    raise exception using errcode = '23503', message = 'El negocio no existe';
  end if;
  if v_business_accepts_bookings is distinct from true then
    raise exception using errcode = '42501', message = 'El negocio no acepta reservas';
  end if;

  select schedule.*
  into v_schedule
  from public.business_schedule as schedule
  where schedule.business_id = p_business_id
    and schedule.day_of_week = extract(dow from p_booking_date)::integer
    and schedule.is_active is true
  for share;

  if not found then
    raise exception using errcode = '22023', message = 'El negocio no atiende ese día';
  end if;
  if v_schedule.slot_duration not between 1 and 1440 then
    raise exception using errcode = '22023', message = 'El intervalo del horario es inválido';
  end if;

  v_duration := coalesce(p_duration_minutes, v_schedule.slot_duration, 60);
  if v_duration not between 1 and 1440 then
    raise exception using errcode = '22023', message = 'La duración de la reserva es inválida';
  end if;
  if p_booking_date + p_booking_time < p_booking_date + v_schedule.open_time
     or p_booking_date + p_booking_time + make_interval(mins => v_duration)
       > p_booking_date + v_schedule.close_time then
    raise exception using errcode = '22023', message = 'La reserva queda fuera del horario de atención';
  end if;
  if mod(
    extract(epoch from (p_booking_time - v_schedule.open_time)),
    v_schedule.slot_duration * 60
  ) <> 0 then
    raise exception using errcode = '22023', message = 'La hora no corresponde a un intervalo disponible';
  end if;

  select booking.*
  into v_booking
  from public.bookings as booking
  where booking.business_id = p_business_id
    and booking.contact_phone = btrim(p_contact_phone)
    and booking.booking_date = p_booking_date
    and booking.booking_time = p_booking_time
    and lower(coalesce(btrim(booking.service), ''))
      = lower(coalesce(btrim(p_service), ''))
    and booking.status in ('pending', 'confirmed')
  order by booking.created_at
  limit 1;

  if found then
    return jsonb_build_object(
      'result', 'duplicate',
      'booking', to_jsonb(v_booking)
    );
  end if;

  if exists (
    select 1
    from public.bookings as booking
    where booking.business_id = p_business_id
      and booking.booking_date = p_booking_date
      and booking.status in ('pending', 'confirmed')
      and p_booking_date + p_booking_time
        < booking.booking_date + booking.booking_time
          + make_interval(mins => booking.duration_minutes)
      and booking.booking_date + booking.booking_time
        < p_booking_date + p_booking_time + make_interval(mins => v_duration)
  ) then
    return jsonb_build_object('result', 'conflict', 'booking', null);
  end if;

  insert into public.bookings (
    business_id,
    contact_phone,
    contact_name,
    service,
    booking_date,
    booking_time,
    duration_minutes,
    notes,
    status
  ) values (
    p_business_id,
    btrim(p_contact_phone),
    nullif(btrim(p_contact_name), ''),
    nullif(btrim(p_service), ''),
    p_booking_date,
    p_booking_time,
    v_duration,
    nullif(btrim(p_notes), ''),
    'pending'
  ) returning * into v_booking;

  return jsonb_build_object('result', 'created', 'booking', to_jsonb(v_booking));
exception
  when exclusion_violation then
    -- La restricción también protege contra una escritura concurrente que no
    -- haya usado esta RPC.
    return jsonb_build_object('result', 'conflict', 'booking', null);
end;
$$;

revoke all on function public.create_booking_if_available(
  uuid, text, text, text, date, time, integer, text
) from public;
revoke all on function public.create_booking_if_available(
  uuid, text, text, text, date, time, integer, text
) from anon;
revoke all on function public.create_booking_if_available(
  uuid, text, text, text, date, time, integer, text
) from authenticated;
grant execute on function public.create_booking_if_available(
  uuid, text, text, text, date, time, integer, text
) to service_role;

commit;

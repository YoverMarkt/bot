-- Capacidades productivas adicionales para WhatsApp Flows:
-- citas, hospedaje y solicitudes de información.
--
-- Requisitos previos:
--   1. migration-atomicidad-reservas.sql
--   2. migration-hospedaje.sql
--   3. migration-whatsapp-flows.sql
--
-- Es aditiva e idempotente. No publica ni activa Flows remotos.

begin;

create extension if not exists pgcrypto;

-- ── Readiness y lease distribuido del aprovisionamiento ───────────────────
-- El backend consulta esta función antes de publicar. Si esta migración no
-- existe, PostgREST no encontrará la RPC y el servidor tratará el esquema como
-- no preparado. La función comprueba además sus piezas críticas para evitar
-- declarar "ready" sobre una instalación parcial.
create or replace function public.whatsapp_flow_capabilities_schema_ready()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    to_regclass('public.business_leads') is not null
    and to_regclass('public.whatsapp_flow_provisioning_leases') is not null
    and (
      select count(*) = 3
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'whatsapp_flow_submissions'
        and column_name in ('booking_id', 'lodging_request_id', 'lead_id')
    )
    and exists (
      select 1
      from pg_attribute as attribute
      where attribute.attrelid = to_regclass('public.business_leads')
        and attribute.attname = 'flow_submission_id'
        and attribute.attnotnull is false
        and attribute.attisdropped is false
    )
    and exists (
      select 1
      from pg_constraint as constraint_record
      join pg_attribute as nullable_column
        on nullable_column.attrelid = constraint_record.conrelid
       and nullable_column.attname = 'flow_submission_id'
       and nullable_column.attisdropped is false
      where constraint_record.conrelid =
          to_regclass('public.business_leads')
        and constraint_record.conname = 'business_leads_submission_fk'
        and constraint_record.contype = 'f'
        and constraint_record.convalidated is true
        and constraint_record.confdeltype = 'n'
        and constraint_record.confdelsetcols =
          array[nullable_column.attnum]::smallint[]
    )
    and exists (
      select 1
      from pg_constraint as constraint_record
      join pg_attribute as nullable_column
        on nullable_column.attrelid = constraint_record.conrelid
       and nullable_column.attname = 'lead_id'
       and nullable_column.attisdropped is false
      where constraint_record.conrelid =
          to_regclass('public.whatsapp_flow_submissions')
        and constraint_record.conname =
          'whatsapp_flow_submissions_lead_fk'
        and constraint_record.contype = 'f'
        and constraint_record.convalidated is true
        and constraint_record.confdeltype = 'n'
        and constraint_record.confdelsetcols =
          array[nullable_column.attnum]::smallint[]
    )
    and exists (
      select 1
      from pg_constraint as constraint_record
      where constraint_record.conrelid =
          to_regclass('public.whatsapp_flow_submissions')
        and constraint_record.conname =
          'whatsapp_flow_submissions_one_resource_check'
        and constraint_record.contype = 'c'
        and constraint_record.convalidated is true
        and pg_get_constraintdef(constraint_record.oid)
          like '%num_nonnulls(order_id, booking_id, lodging_request_id, lead_id) <= 1%'
    )
    and to_regprocedure(
      'public.create_booking_from_flow_submission(uuid,uuid,text)'
    ) is not null
    and to_regprocedure(
      'public.create_lodging_request_from_flow_submission(uuid,uuid,text)'
    ) is not null
    and to_regprocedure(
      'public.create_lead_from_flow_submission(uuid,uuid,text)'
    ) is not null
    and to_regprocedure(
      'public.acquire_whatsapp_flow_provisioning_lease(uuid,text,uuid,integer)'
    ) is not null
    and to_regprocedure(
      'public.renew_whatsapp_flow_provisioning_lease(uuid,text,uuid,integer)'
    ) is not null
    and to_regprocedure(
      'public.release_whatsapp_flow_provisioning_lease(uuid,text,uuid)'
    ) is not null;
$$;

create table if not exists public.whatsapp_flow_provisioning_leases (
  business_id       uuid not null
                    references public.businesses(id) on delete cascade,
  template_key      text not null
                    check (template_key ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  owner_token       uuid not null,
  lease_expires_at  timestamptz not null,
  acquired_at       timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (business_id, template_key)
);

create index if not exists idx_whatsapp_flow_provisioning_leases_expiry
  on public.whatsapp_flow_provisioning_leases (lease_expires_at);

create or replace function public.acquire_whatsapp_flow_provisioning_lease(
  p_business_id uuid,
  p_template_key text,
  p_owner_token uuid,
  p_lease_seconds integer default 900
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acquired boolean := false;
  v_template_key text := btrim(coalesce(p_template_key, ''));
begin
  if p_business_id is null
     or p_owner_token is null
     or v_template_key !~ '^[a-z][a-z0-9_.-]{1,63}$'
     or p_lease_seconds not between 30 and 1800 then
    raise exception using
      errcode = '22023',
      message = 'Los parámetros del lease de Flow no son válidos';
  end if;

  insert into public.whatsapp_flow_provisioning_leases as lease (
    business_id,
    template_key,
    owner_token,
    lease_expires_at,
    acquired_at,
    updated_at
  ) values (
    p_business_id,
    v_template_key,
    p_owner_token,
    now() + make_interval(secs => p_lease_seconds),
    now(),
    now()
  )
  on conflict (business_id, template_key) do update
  set owner_token = excluded.owner_token,
      lease_expires_at = excluded.lease_expires_at,
      acquired_at = excluded.acquired_at,
      updated_at = now()
  where lease.lease_expires_at <= now()
     or lease.owner_token = excluded.owner_token
  returning true into v_acquired;

  return coalesce(v_acquired, false);
end;
$$;

create or replace function public.renew_whatsapp_flow_provisioning_lease(
  p_business_id uuid,
  p_template_key text,
  p_owner_token uuid,
  p_lease_seconds integer default 900
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_renewed boolean := false;
begin
  if p_business_id is null
     or p_owner_token is null
     or nullif(btrim(coalesce(p_template_key, '')), '') is null
     or p_lease_seconds not between 30 and 1800 then
    raise exception using
      errcode = '22023',
      message = 'Los parámetros del lease de Flow no son válidos';
  end if;

  update public.whatsapp_flow_provisioning_leases
  set lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where business_id = p_business_id
    and template_key = btrim(p_template_key)
    and owner_token = p_owner_token
    and lease_expires_at > now()
  returning true into v_renewed;

  return coalesce(v_renewed, false);
end;
$$;

create or replace function public.release_whatsapp_flow_provisioning_lease(
  p_business_id uuid,
  p_template_key text,
  p_owner_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer := 0;
begin
  if p_business_id is null
     or p_owner_token is null
     or nullif(btrim(coalesce(p_template_key, '')), '') is null then
    raise exception using
      errcode = '22023',
      message = 'Los parámetros del lease de Flow no son válidos';
  end if;

  delete from public.whatsapp_flow_provisioning_leases
  where business_id = p_business_id
    and template_key = btrim(p_template_key)
    and owner_token = p_owner_token;
  get diagnostics v_deleted = row_count;

  return v_deleted = 1;
end;
$$;

-- ── Enlaces idempotentes de cada respuesta con su recurso real ─────────────
alter table public.whatsapp_flow_submissions
  add column if not exists booking_id uuid,
  add column if not exists lodging_request_id uuid,
  add column if not exists lead_id uuid;

alter table public.bookings
  add column if not exists flow_submission_id uuid;

alter table public.lodging_requests
  add column if not exists flow_submission_id uuid;

create unique index if not exists uq_bookings_flow_submission
  on public.bookings (flow_submission_id)
  where flow_submission_id is not null;

create unique index if not exists uq_bookings_id_business
  on public.bookings (id, business_id);

create unique index if not exists uq_lodging_requests_flow_submission
  on public.lodging_requests (flow_submission_id)
  where flow_submission_id is not null;

create index if not exists idx_flow_submissions_booking_fk
  on public.whatsapp_flow_submissions (booking_id, business_id)
  where booking_id is not null;

create index if not exists idx_flow_submissions_lodging_fk
  on public.whatsapp_flow_submissions (lodging_request_id, business_id)
  where lodging_request_id is not null;

create index if not exists idx_flow_submissions_lead_fk
  on public.whatsapp_flow_submissions (lead_id, business_id)
  where lead_id is not null;

do $$
begin
  -- Una ejecución anterior pudo crear este mismo nombre antes de incorporar
  -- lead_id. No basta con detectar el nombre: se reconstruye si la definición
  -- no garantiza exactamente un único recurso entre las cuatro columnas.
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.whatsapp_flow_submissions'::regclass
      and conname = 'whatsapp_flow_submissions_one_resource_check'
      and (
        contype <> 'c'
        or pg_get_constraintdef(oid) not like
          '%num_nonnulls(order_id, booking_id, lodging_request_id, lead_id) <= 1%'
      )
  ) then
    alter table public.whatsapp_flow_submissions
      drop constraint whatsapp_flow_submissions_one_resource_check;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.whatsapp_flow_submissions'::regclass
      and conname = 'whatsapp_flow_submissions_booking_fk'
  ) then
    alter table public.whatsapp_flow_submissions
      add constraint whatsapp_flow_submissions_booking_fk
      foreign key (booking_id, business_id)
      references public.bookings (id, business_id)
      on delete cascade;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.whatsapp_flow_submissions'::regclass
      and conname = 'whatsapp_flow_submissions_lodging_fk'
  ) then
    alter table public.whatsapp_flow_submissions
      add constraint whatsapp_flow_submissions_lodging_fk
      foreign key (lodging_request_id, business_id)
      references public.lodging_requests (id, business_id)
      on delete cascade;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.whatsapp_flow_submissions'::regclass
      and conname = 'whatsapp_flow_submissions_one_resource_check'
  ) then
    alter table public.whatsapp_flow_submissions
      add constraint whatsapp_flow_submissions_one_resource_check
      check (
        num_nonnulls(order_id, booking_id, lodging_request_id, lead_id) <= 1
      ) not valid;
  end if;
end;
$$;

alter table public.whatsapp_flow_submissions
  validate constraint whatsapp_flow_submissions_one_resource_check;

-- ── Solicitudes estructuradas para negocios informativos ───────────────────
create table if not exists public.business_leads (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null
                      references public.businesses(id) on delete cascade,
  -- El lead es un registro comercial y debe sobrevivir si en el futuro se
  -- limpia una sesión/versión técnica del Flow. Mientras el submission
  -- exista, este enlace conserva la deduplicación exacta.
  flow_submission_id  uuid,
  contact_phone       text not null
                      check (char_length(btrim(contact_phone)) between 1 and 80),
  contact_name        text not null
                      check (char_length(btrim(contact_name)) between 2 and 120),
  topic               text not null
                      check (char_length(btrim(topic)) between 1 and 120),
  details             text not null
                      check (char_length(btrim(details)) between 2 and 2000),
  email               text
                      check (
                        email is null
                        or (
                          email = btrim(email)
                          and char_length(email) between 3 and 254
                        )
                      ),
  preferred_time      text
                      check (char_length(coalesce(preferred_time, '')) <= 160),
  status              text not null default 'new'
                      check (status in (
                        'new', 'in_progress', 'resolved', 'discarded'
                      )),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, flow_submission_id)
);

-- También corrige instalaciones que alcanzaron a ejecutar una revisión
-- anterior de esta migración, donde ambos enlaces usaban CASCADE.
alter table public.business_leads
  alter column flow_submission_id drop not null;

alter table public.business_leads
  drop constraint if exists business_leads_submission_fk;
alter table public.business_leads
  add constraint business_leads_submission_fk
  foreign key (flow_submission_id, business_id)
  references public.whatsapp_flow_submissions (id, business_id)
  on delete set null (flow_submission_id);

create index if not exists idx_business_leads_business_status
  on public.business_leads (business_id, status, created_at desc);

alter table public.whatsapp_flow_submissions
  drop constraint if exists whatsapp_flow_submissions_lead_fk;
alter table public.whatsapp_flow_submissions
  add constraint whatsapp_flow_submissions_lead_fk
  foreign key (lead_id, business_id)
  references public.business_leads (id, business_id)
  on delete set null (lead_id);

-- ── Disponibilidad de citas calculada en la zona horaria del negocio ───────
-- La tabla actual representa una agenda simple de un solo recurso. La función
-- usa la duración real del servicio y deja que create_booking_if_available sea
-- la autoridad final bajo concurrencia.
create or replace function public.get_whatsapp_flow_booking_availability(
  p_business_id uuid,
  p_service_id uuid default null,
  p_days_ahead integer default 30
)
returns table (
  booking_date date,
  booking_time time,
  duration_minutes integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_service_duration integer;
  v_accepts_bookings boolean;
  v_local_now timestamp := now() at time zone 'America/Guayaquil';
begin
  if p_business_id is null
     or p_days_ahead < 1
     or p_days_ahead > 60 then
    raise exception using
      errcode = '22023',
      message = 'Los parámetros de disponibilidad no son válidos';
  end if;

  select (
    business.takes_bookings is true
    and business.active is true
    and business.bot_active is true
    and business.suspended is not true
  )
  into v_accepts_bookings
  from public.businesses as business
  where business.id = p_business_id;

  if not found then
    raise exception using errcode = '23503', message = 'El negocio no existe';
  end if;
  if v_accepts_bookings is distinct from true then
    raise exception using
      errcode = '42501',
      message = 'El negocio no acepta citas';
  end if;

  if p_service_id is not null then
    select product.duration_minutes
    into v_service_duration
    from public.products as product
    where product.id = p_service_id
      and product.business_id = p_business_id
      and product.active is true
      and product.duration_minutes between 1 and 1440;

    if not found then
      raise exception using
        errcode = '22023',
        message = 'El servicio no está disponible';
    end if;
  end if;

  return query
  with candidate_days as (
    select (v_local_now::date + offset_value)::date as service_date
    from generate_series(0, p_days_ahead) as offset_value
  ),
  configured_days as (
    select
      candidate.service_date,
      schedule.open_time,
      schedule.close_time,
      schedule.slot_duration,
      coalesce(v_service_duration, schedule.slot_duration) as service_duration
    from candidate_days as candidate
    join public.business_schedule as schedule
      on schedule.business_id = p_business_id
     and schedule.day_of_week =
       extract(dow from candidate.service_date)::integer
     and schedule.is_active is true
    where schedule.slot_duration between 1 and 1440
      and coalesce(v_service_duration, schedule.slot_duration)
        between 1 and 1440
  ),
  candidate_slots as (
    select
      configured.service_date,
      slot_start,
      configured.service_duration
    from configured_days as configured
    cross join lateral generate_series(
      configured.service_date + configured.open_time,
      configured.service_date + configured.close_time
        - make_interval(mins => configured.service_duration),
      make_interval(mins => configured.slot_duration)
    ) as slot_start
    where configured.service_date + configured.close_time
      >= configured.service_date + configured.open_time
        + make_interval(mins => configured.service_duration)
  )
  select
    candidate.service_date,
    candidate.slot_start::time,
    candidate.service_duration
  from candidate_slots as candidate
  where candidate.slot_start > v_local_now
    and not exists (
      select 1
      from public.bookings as booking
      where booking.business_id = p_business_id
        and booking.status in ('pending', 'confirmed')
        and candidate.slot_start
          < booking.booking_date + booking.booking_time
            + make_interval(mins => booking.duration_minutes)
        and booking.booking_date + booking.booking_time
          < candidate.slot_start
            + make_interval(mins => candidate.service_duration)
    )
  order by candidate.service_date, candidate.slot_start
  limit 2000;
end;
$$;

-- ── Cita desde un submission, exactamente una vez ──────────────────────────
create or replace function public.create_booking_from_flow_submission(
  p_business_id uuid,
  p_submission_id uuid,
  p_contact_phone text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_submission public.whatsapp_flow_submissions%rowtype;
  v_session record;
  v_draft jsonb;
  v_service_id_text text;
  v_service_id uuid;
  v_service_name text;
  v_duration integer;
  v_expected_duration integer;
  v_booking_date date;
  v_booking_time time;
  v_contact_name text;
  v_notes text;
  v_result jsonb;
  v_booking public.bookings%rowtype;
begin
  if p_business_id is null
     or p_submission_id is null
     or nullif(btrim(coalesce(p_contact_phone, '')), '') is null then
    raise exception using
      errcode = '22023',
      message = 'Negocio, submission y contacto son obligatorios';
  end if;

  select submission.*
  into v_submission
  from public.whatsapp_flow_submissions as submission
  where submission.id = p_submission_id
    and submission.business_id = p_business_id
  for update;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'El submission no pertenece al negocio';
  end if;

  if v_submission.booking_id is not null then
    select booking.*
    into v_booking
    from public.bookings as booking
    where booking.id = v_submission.booking_id
      and booking.business_id = p_business_id;
    if found then
      return jsonb_build_object(
        'result', 'duplicate',
        'created', false,
        'booking', to_jsonb(v_booking)
      );
    end if;
  end if;

  select
    session.*,
    definition.capability_key as resolved_capability_key
  into v_session
  from public.whatsapp_flow_sessions as session
  join public.whatsapp_flow_versions as flow_version
    on flow_version.id = session.flow_version_id
   and flow_version.business_id = session.business_id
  join public.whatsapp_flow_definitions as definition
    on definition.id = flow_version.flow_id
   and definition.business_id = flow_version.business_id
  where session.id = v_submission.session_id
    and session.business_id = p_business_id
  for update of session;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'La sesión no pertenece al negocio';
  end if;
  if not (
    v_session.resolved_capability_key = 'appointment'
    or v_session.resolved_capability_key like 'appointment.%'
  ) then
    raise exception using
      errcode = '22023',
      message = 'El Flow no tiene capacidad de citas';
  end if;
  if v_session.contact_key_hash <> encode(digest(convert_to(
    v_session.provider
      || ':' || p_business_id::text
      || ':' || btrim(p_contact_phone),
    'UTF8'
  ), 'sha256'), 'hex') then
    raise exception using
      errcode = '42501',
      message = 'El contacto no corresponde a la sesión';
  end if;
  if v_submission.processing_status not in ('received', 'processing') then
    raise exception using
      errcode = '22023',
      message = 'El submission ya no puede crear una cita';
  end if;

  v_draft := v_session.context -> 'appointment_draft';
  if jsonb_typeof(v_draft) is distinct from 'object' then
    raise exception using
      errcode = '22023',
      message = 'La cita no tiene un borrador validado';
  end if;

  begin
    -- Servicio, fecha y hora se fijan en el contexto canónico durante cada
    -- paso. El borrador final contiene únicamente los datos escritos por el
    -- cliente; no debemos esperar esos identificadores dentro del borrador.
    v_service_id_text := nullif(v_session.context ->> 'service_id', '');
    if v_service_id_text is not null and v_service_id_text <> 'general' then
      v_service_id := v_service_id_text::uuid;
      v_expected_duration := (v_session.context ->> 'duration_minutes')::integer;
    end if;
    v_booking_date := (v_session.context ->> 'booking_date')::date;
    v_booking_time := (v_session.context ->> 'booking_time')::time;
  exception
    when invalid_text_representation
      or datetime_field_overflow
      or numeric_value_out_of_range then
      raise exception using
        errcode = '22023',
        message = 'La fecha, hora o servicio de la cita no son válidos';
  end;

  v_contact_name := nullif(btrim(coalesce(v_draft ->> 'contact_name', '')), '');
  v_notes := nullif(btrim(coalesce(v_draft ->> 'notes', '')), '');
  if v_contact_name is null
     or char_length(v_contact_name) not between 2 and 120
     or char_length(coalesce(v_notes, '')) > 1000 then
    raise exception using
      errcode = '22023',
      message = 'Los datos de contacto de la cita no son válidos';
  end if;

  if v_service_id is not null then
    if v_expected_duration is null
       or v_expected_duration not between 1 and 1440 then
      raise exception using
        errcode = '22023',
        message = 'La duración validada del servicio no es válida';
    end if;
    select product.name, product.duration_minutes
    into v_service_name, v_duration
    from public.products as product
    where product.id = v_service_id
      and product.business_id = p_business_id
      and product.active is true
      and product.duration_minutes between 1 and 1440
    for share;
    if not found then
      return jsonb_build_object(
        'result', 'service_changed',
        'created', false,
        'booking', null
      );
    end if;
    if v_duration <> v_expected_duration then
      return jsonb_build_object(
        'result', 'service_changed',
        'created', false,
        'booking', null
      );
    end if;
  else
    v_service_name := 'Cita';
    v_duration := null;
  end if;

  begin
    v_result := public.create_booking_if_available(
      p_business_id,
      btrim(p_contact_phone),
      v_contact_name,
      v_service_name,
      v_booking_date,
      v_booking_time,
      v_duration,
      v_notes
    );
  exception
    -- El horario, su intervalo o la capacidad de citas pueden cambiar entre
    -- la revisión del Flow y el webhook terminal. Es un rechazo de negocio
    -- recuperable, no un error técnico que deba quedar reintentándose.
    when sqlstate '22023' or sqlstate '42501' then
      return jsonb_build_object(
        'result', 'slot_unavailable',
        'created', false,
        'booking', null
      );
  end;

  if v_result ->> 'result' not in ('created', 'duplicate') then
    return v_result || jsonb_build_object('created', false);
  end if;

  v_booking := jsonb_populate_record(
    null::public.bookings,
    v_result -> 'booking'
  );
  if v_booking.id is null or v_booking.business_id <> p_business_id then
    raise exception using
      errcode = 'P0001',
      message = 'La base no devolvió una cita válida';
  end if;
  if v_result ->> 'result' = 'duplicate'
     and v_service_id is not null
     and v_booking.duration_minutes is distinct from v_duration then
    -- La RPC legacy deduplica por nombre del servicio. Dos productos pueden
    -- compartir nombre y tener duraciones distintas; en ese caso no debemos
    -- enlazar este Flow a una cita de otro servicio.
    return jsonb_build_object(
      'result', 'service_changed',
      'created', false,
      'booking', null
    );
  end if;

  update public.bookings as booking
  set flow_submission_id = coalesce(
        booking.flow_submission_id,
        v_submission.id
      )
  where booking.id = v_booking.id
    and booking.business_id = p_business_id
    and (
      booking.flow_submission_id is null
      or booking.flow_submission_id = v_submission.id
    )
  returning booking.* into v_booking;

  if not found then
    -- Dos sesiones del mismo contacto pueden haber mostrado el mismo horario
    -- antes del primer envío. La RPC canónica devuelve la misma cita como
    -- duplicate; el enlace inverso conserva el submission que la creó, pero
    -- ambos submissions pueden apuntar de forma segura al mismo recurso.
    if v_result ->> 'result' <> 'duplicate' then
      raise exception using
        errcode = '23505',
        message = 'La cita ya está enlazada a otra respuesta';
    end if;
    select booking.*
    into v_booking
    from public.bookings as booking
    where booking.id = (v_result -> 'booking' ->> 'id')::uuid
      and booking.business_id = p_business_id;
    if not found then
      raise exception using
        errcode = 'P0001',
        message = 'No se pudo recuperar la cita duplicada';
    end if;
  end if;

  update public.whatsapp_flow_submissions
  set processing_status = 'processed',
      booking_id = v_booking.id,
      error_code = null,
      processed_at = now(),
      updated_at = now()
  where id = v_submission.id;

  return jsonb_build_object(
    'result', v_result ->> 'result',
    'created', (v_result ->> 'result') = 'created',
    'booking', to_jsonb(v_booking)
  );
end;
$$;

-- ── Hospedaje desde un submission, fijado a la cotización de la sesión ─────
create or replace function public.create_lodging_request_from_flow_submission(
  p_business_id uuid,
  p_submission_id uuid,
  p_contact_phone text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_submission public.whatsapp_flow_submissions%rowtype;
  v_session record;
  v_draft jsonb;
  v_quote public.lodging_quotes%rowtype;
  v_request public.lodging_requests%rowtype;
  v_quote_id uuid;
  v_room_type_id uuid;
  v_contact_name text;
  v_notes text;
  v_alias text;
  v_result jsonb;
begin
  if p_business_id is null
     or p_submission_id is null
     or nullif(btrim(coalesce(p_contact_phone, '')), '') is null then
    raise exception using
      errcode = '22023',
      message = 'Negocio, submission y contacto son obligatorios';
  end if;

  -- Mantener el mismo orden de locks que la RPC canónica de hospedaje:
  -- advisory del negocio antes de bloquear o modificar una cotización.
  perform pg_advisory_xact_lock(
    hashtextextended(p_business_id::text || ':lodging', 0)
  );

  select submission.*
  into v_submission
  from public.whatsapp_flow_submissions as submission
  where submission.id = p_submission_id
    and submission.business_id = p_business_id
  for update;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'El submission no pertenece al negocio';
  end if;

  if v_submission.lodging_request_id is not null then
    select request.*
    into v_request
    from public.lodging_requests as request
    where request.id = v_submission.lodging_request_id
      and request.business_id = p_business_id;
    if found then
      return jsonb_build_object(
        'result', 'duplicate',
        'created', false,
        'request', public.lodging_request_to_json(v_request)
      );
    end if;
  end if;

  select
    session.*,
    definition.capability_key as resolved_capability_key
  into v_session
  from public.whatsapp_flow_sessions as session
  join public.whatsapp_flow_versions as flow_version
    on flow_version.id = session.flow_version_id
   and flow_version.business_id = session.business_id
  join public.whatsapp_flow_definitions as definition
    on definition.id = flow_version.flow_id
   and definition.business_id = flow_version.business_id
  where session.id = v_submission.session_id
    and session.business_id = p_business_id
  for update of session;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'La sesión no pertenece al negocio';
  end if;
  if not (
    v_session.resolved_capability_key = 'lodging'
    or v_session.resolved_capability_key like 'lodging.%'
  ) then
    raise exception using
      errcode = '22023',
      message = 'El Flow no tiene capacidad de hospedaje';
  end if;
  if v_session.contact_key_hash <> encode(digest(convert_to(
    v_session.provider
      || ':' || p_business_id::text
      || ':' || btrim(p_contact_phone),
    'UTF8'
  ), 'sha256'), 'hex') then
    raise exception using
      errcode = '42501',
      message = 'El contacto no corresponde a la sesión';
  end if;
  if v_submission.processing_status not in ('received', 'processing') then
    raise exception using
      errcode = '22023',
      message = 'El submission ya no puede crear una solicitud';
  end if;

  v_draft := v_session.context -> 'lodging_draft';
  if jsonb_typeof(v_draft) is distinct from 'object' then
    raise exception using
      errcode = '22023',
      message = 'El hospedaje no tiene un borrador validado';
  end if;

  begin
    v_quote_id := (v_draft ->> 'quote_id')::uuid;
    v_room_type_id := (v_draft ->> 'room_type_id')::uuid;
  exception
    when invalid_text_representation then
      raise exception using
        errcode = '22023',
        message = 'La cotización o habitación no es válida';
  end;

  v_contact_name := nullif(btrim(coalesce(v_draft ->> 'contact_name', '')), '');
  v_notes := nullif(btrim(coalesce(v_draft ->> 'notes', '')), '');
  if v_contact_name is null
     or char_length(v_contact_name) not between 2 and 120
     or char_length(coalesce(v_notes, '')) > 1000 then
    raise exception using
      errcode = '22023',
      message = 'Los datos del huésped no son válidos';
  end if;

  v_alias := 'flow-session:' || v_session.id::text;
  select quote.*
  into v_quote
  from public.lodging_quotes as quote
  where quote.id = v_quote_id
    and quote.business_id = p_business_id
  for update;

  if not found then
    return jsonb_build_object(
      'result', 'quote_not_found',
      'created', false,
      'request', null
    );
  end if;
  if v_quote.contact_phone not in (v_alias, btrim(p_contact_phone)) then
    raise exception using
      errcode = '42501',
      message = 'La cotización no pertenece a la sesión';
  end if;

  if v_quote.contact_phone = v_alias then
    update public.lodging_quotes
    set contact_phone = btrim(p_contact_phone),
        contact_name = coalesce(v_contact_name, contact_name)
    where id = v_quote.id
      and business_id = p_business_id
    returning * into v_quote;
  end if;

  begin
    v_result := public.create_lodging_request_if_available(
      p_business_id,
      v_quote.id,
      v_room_type_id,
      btrim(p_contact_phone),
      v_contact_name,
      'flow:' || v_submission.id::text,
      v_notes
    );
  exception
    -- Configuración, estado del módulo o reglas de la tarifa pueden cambiar
    -- después de mostrar la revisión. Se informa disponibilidad cambiada.
    when sqlstate '22023' or sqlstate '42501' then
      return jsonb_build_object(
        'result', 'lodging_unavailable',
        'created', false,
        'request', null
      );
  end;

  if v_result ->> 'result' not in ('created', 'duplicate') then
    return v_result || jsonb_build_object('created', false);
  end if;

  v_request := jsonb_populate_record(
    null::public.lodging_requests,
    v_result -> 'request'
  );
  if v_request.id is null or v_request.business_id <> p_business_id then
    raise exception using
      errcode = 'P0001',
      message = 'La base no devolvió una solicitud válida';
  end if;

  update public.lodging_requests as request
  set flow_submission_id = coalesce(
        request.flow_submission_id,
        v_submission.id
      ),
      updated_at = now()
  where request.id = v_request.id
    and request.business_id = p_business_id
    and (
      request.flow_submission_id is null
      or request.flow_submission_id = v_submission.id
    )
  returning request.* into v_request;

  if not found then
    raise exception using
      errcode = '23505',
      message = 'La solicitud ya está enlazada a otra respuesta';
  end if;

  update public.whatsapp_flow_submissions
  set processing_status = 'processed',
      lodging_request_id = v_request.id,
      error_code = null,
      processed_at = now(),
      updated_at = now()
  where id = v_submission.id;

  return jsonb_build_object(
    'result', v_result ->> 'result',
    'created', (v_result ->> 'result') = 'created',
    'request', public.lodging_request_to_json(v_request)
  );
end;
$$;

-- ── Lead desde un submission, exactamente una vez ──────────────────────────
create or replace function public.create_lead_from_flow_submission(
  p_business_id uuid,
  p_submission_id uuid,
  p_contact_phone text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_submission public.whatsapp_flow_submissions%rowtype;
  v_session record;
  v_draft jsonb;
  v_lead public.business_leads%rowtype;
  v_contact_name text;
  v_topic text;
  v_details text;
  v_email text;
  v_preferred_time text;
begin
  if p_business_id is null
     or p_submission_id is null
     or nullif(btrim(coalesce(p_contact_phone, '')), '') is null then
    raise exception using
      errcode = '22023',
      message = 'Negocio, submission y contacto son obligatorios';
  end if;

  select submission.*
  into v_submission
  from public.whatsapp_flow_submissions as submission
  where submission.id = p_submission_id
    and submission.business_id = p_business_id
  for update;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'El submission no pertenece al negocio';
  end if;

  if v_submission.lead_id is not null then
    select lead.*
    into v_lead
    from public.business_leads as lead
    where lead.id = v_submission.lead_id
      and lead.business_id = p_business_id;
    if found then
      return jsonb_build_object(
        'result', 'duplicate',
        'created', false,
        'lead', to_jsonb(v_lead)
      );
    end if;
  end if;

  select
    session.*,
    definition.capability_key as resolved_capability_key
  into v_session
  from public.whatsapp_flow_sessions as session
  join public.whatsapp_flow_versions as flow_version
    on flow_version.id = session.flow_version_id
   and flow_version.business_id = session.business_id
  join public.whatsapp_flow_definitions as definition
    on definition.id = flow_version.flow_id
   and definition.business_id = flow_version.business_id
  where session.id = v_submission.session_id
    and session.business_id = p_business_id
  for update of session;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'La sesión no pertenece al negocio';
  end if;
  if not (
    v_session.resolved_capability_key = 'lead'
    or v_session.resolved_capability_key like 'lead.%'
  ) then
    raise exception using
      errcode = '22023',
      message = 'El Flow no tiene capacidad de solicitudes';
  end if;
  if v_session.contact_key_hash <> encode(digest(convert_to(
    v_session.provider
      || ':' || p_business_id::text
      || ':' || btrim(p_contact_phone),
    'UTF8'
  ), 'sha256'), 'hex') then
    raise exception using
      errcode = '42501',
      message = 'El contacto no corresponde a la sesión';
  end if;
  if v_submission.processing_status not in ('received', 'processing') then
    raise exception using
      errcode = '22023',
      message = 'El submission ya no puede crear una solicitud';
  end if;

  v_draft := v_session.context -> 'lead_draft';
  if jsonb_typeof(v_draft) is distinct from 'object' then
    raise exception using
      errcode = '22023',
      message = 'La solicitud no tiene un borrador validado';
  end if;

  v_contact_name := nullif(btrim(coalesce(v_draft ->> 'contact_name', '')), '');
  v_topic := nullif(btrim(coalesce(
    v_draft ->> 'topic_label',
    v_draft ->> 'topic',
    ''
  )), '');
  v_details := nullif(btrim(coalesce(v_draft ->> 'details', '')), '');
  v_email := nullif(lower(btrim(coalesce(v_draft ->> 'email', ''))), '');
  v_preferred_time := nullif(
    btrim(coalesce(v_draft ->> 'preferred_time', '')),
    ''
  );

  if v_contact_name is null
     or char_length(v_contact_name) not between 2 and 120
     or v_topic is null
     or char_length(v_topic) > 120
     or v_details is null
     or char_length(v_details) not between 2 and 2000
     or char_length(coalesce(v_preferred_time, '')) > 160
     or (
       v_email is not null
       and (
         char_length(v_email) not between 3 and 254
         or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
       )
     ) then
    raise exception using
      errcode = '22023',
      message = 'Los datos de la solicitud no son válidos';
  end if;

  select lead.*
  into v_lead
  from public.business_leads as lead
  where lead.business_id = p_business_id
    and lead.flow_submission_id = v_submission.id;

  if found then
    update public.whatsapp_flow_submissions
    set processing_status = 'processed',
        lead_id = v_lead.id,
        error_code = null,
        processed_at = coalesce(processed_at, now()),
        updated_at = now()
    where id = v_submission.id;
    return jsonb_build_object(
      'result', 'duplicate',
      'created', false,
      'lead', to_jsonb(v_lead)
    );
  end if;

  insert into public.business_leads (
    business_id,
    flow_submission_id,
    contact_phone,
    contact_name,
    topic,
    details,
    email,
    preferred_time
  ) values (
    p_business_id,
    v_submission.id,
    btrim(p_contact_phone),
    v_contact_name,
    v_topic,
    v_details,
    v_email,
    v_preferred_time
  )
  returning * into v_lead;

  update public.whatsapp_flow_submissions
  set processing_status = 'processed',
      lead_id = v_lead.id,
      error_code = null,
      processed_at = now(),
      updated_at = now()
  where id = v_submission.id;

  return jsonb_build_object(
    'result', 'created',
    'created', true,
    'lead', to_jsonb(v_lead)
  );
end;
$$;

-- ── Seguridad ───────────────────────────────────────────────────────────────
alter table public.business_leads enable row level security;
alter table public.whatsapp_flow_provisioning_leases enable row level security;

revoke all on table public.business_leads
  from public, anon, authenticated, service_role;
grant select, insert, update
  on table public.business_leads to service_role;

revoke all on table public.whatsapp_flow_provisioning_leases
  from public, anon, authenticated, service_role;
grant select, insert, update, delete
  on table public.whatsapp_flow_provisioning_leases to service_role;

revoke all on function public.whatsapp_flow_capabilities_schema_ready()
  from public, anon, authenticated;
revoke all on function public.acquire_whatsapp_flow_provisioning_lease(
  uuid, text, uuid, integer
) from public, anon, authenticated;
revoke all on function public.renew_whatsapp_flow_provisioning_lease(
  uuid, text, uuid, integer
) from public, anon, authenticated;
revoke all on function public.release_whatsapp_flow_provisioning_lease(
  uuid, text, uuid
) from public, anon, authenticated;

revoke all on function public.get_whatsapp_flow_booking_availability(
  uuid, uuid, integer
) from public, anon, authenticated;
revoke all on function public.create_booking_from_flow_submission(
  uuid, uuid, text
) from public, anon, authenticated;
revoke all on function public.create_lodging_request_from_flow_submission(
  uuid, uuid, text
) from public, anon, authenticated;
revoke all on function public.create_lead_from_flow_submission(
  uuid, uuid, text
) from public, anon, authenticated;

grant execute on function public.get_whatsapp_flow_booking_availability(
  uuid, uuid, integer
) to service_role;
grant execute on function public.create_booking_from_flow_submission(
  uuid, uuid, text
) to service_role;
grant execute on function public.create_lodging_request_from_flow_submission(
  uuid, uuid, text
) to service_role;
grant execute on function public.create_lead_from_flow_submission(
  uuid, uuid, text
) to service_role;
grant execute on function public.whatsapp_flow_capabilities_schema_ready()
  to service_role;
grant execute on function public.acquire_whatsapp_flow_provisioning_lease(
  uuid, text, uuid, integer
) to service_role;
grant execute on function public.renew_whatsapp_flow_provisioning_lease(
  uuid, text, uuid, integer
) to service_role;
grant execute on function public.release_whatsapp_flow_provisioning_lease(
  uuid, text, uuid
) to service_role;

commit;

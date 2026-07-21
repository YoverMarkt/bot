-- Módulo transaccional de hospedaje: inventario agregado por tipo de habitación,
-- cotizaciones oficiales y holds pendientes de confirmación del dueño.
-- Es aditivo e idempotente. No reutiliza la agenda simple (`bookings`).

begin;

create extension if not exists btree_gist;

alter table public.businesses
  add column if not exists lodging_enabled boolean not null default false;

create table if not exists public.lodging_settings (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses(id) on delete cascade,
  currency              text not null default 'USD'
                        check (currency in ('USD','EUR','COP','PEN','MXN','BRL','CLP','ARS')),
  tax_rate              numeric(7,6) not null default 0
                        check (tax_rate between 0 and 1),
  service_fee           numeric(12,2) not null default 0
                        check (service_fee >= 0),
  prices_include_tax    boolean not null default true,
  check_in_time         time not null default '15:00',
  check_out_time        time not null default '11:00',
  quote_expiry_minutes  integer not null default 15
                        check (quote_expiry_minutes between 1 and 1440),
  hold_minutes          integer not null default 45
                        check (hold_minutes between 5 and 1440),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (business_id),
  unique (business_id, id)
);

create table if not exists public.lodging_room_types (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses(id) on delete cascade,
  name              text not null check (char_length(btrim(name)) between 1 and 120),
  description       text,
  amenities         text[] not null default '{}',
  media_urls       text[] not null default '{}',
  total_units       integer not null check (total_units between 1 and 10000),
  base_occupancy    integer not null default 1
                    check (base_occupancy between 1 and 100),
  max_guests        integer not null default 1
                    check (max_guests between 1 and 100),
  pricing_model     text not null default 'per_unit'
                    check (pricing_model in (
                      'per_unit', 'per_person', 'base_plus_extra', 'manual'
                    )),
  base_rate         numeric(12,2),
  weekend_rate      numeric(12,2),
  extra_adult_rate  numeric(12,2) not null default 0,
  child_rate        numeric(12,2) not null default 0,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (business_id, id),
  constraint lodging_room_types_capacity_check
    check (max_guests >= base_occupancy),
  constraint lodging_room_types_rates_check check (
    (pricing_model = 'manual' and base_rate is null)
    or (pricing_model <> 'manual' and base_rate > 0)
  ),
  constraint lodging_room_types_optional_rates_check check (
    (weekend_rate is null or weekend_rate > 0)
    and extra_adult_rate >= 0
    and child_rate >= 0
  )
);

create table if not exists public.lodging_rate_overrides (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses(id) on delete cascade,
  room_type_id      uuid not null,
  rate_date         date not null,
  base_rate         numeric(12,2),
  extra_adult_rate  numeric(12,2),
  child_rate        numeric(12,2),
  closed            boolean not null default false,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (business_id, room_type_id)
    references public.lodging_room_types(business_id, id) on delete cascade,
  unique (business_id, room_type_id, rate_date),
  constraint lodging_rate_overrides_rates_check check (
    (base_rate is null or base_rate > 0)
    and (extra_adult_rate is null or extra_adult_rate >= 0)
    and (child_rate is null or child_rate >= 0)
  )
);

create table if not exists public.lodging_quotes (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses(id) on delete cascade,
  contact_phone         text not null check (char_length(btrim(contact_phone)) between 1 and 80),
  contact_name          text,
  check_in              date not null,
  check_out             date not null,
  check_in_time         time not null,
  check_out_time        time not null,
  adults                integer not null check (adults between 1 and 500),
  children              integer not null default 0 check (children between 0 and 500),
  rooms_count           integer not null default 1 check (rooms_count between 1 and 100),
  nights                integer not null check (nights between 1 and 366),
  currency              text not null
                        check (currency in ('USD','EUR','COP','PEN','MXN','BRL','CLP','ARS')),
  options               jsonb not null default '[]'::jsonb
                        check (jsonb_typeof(options) = 'array'),
  status                text not null default 'quoted'
                        check (status in ('quoted', 'accepted', 'expired')),
  expires_at            timestamptz not null,
  accepted_at           timestamptz,
  idempotency_key_hash  text
                        check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  created_at            timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, idempotency_key_hash),
  constraint lodging_quotes_dates_check check (check_out > check_in),
  -- `nights check (...)` ya recibe automáticamente el nombre
  -- lodging_quotes_nights_check. Usa otro nombre para la relación con fechas.
  constraint lodging_quotes_nights_match_dates_check
    check (nights = check_out - check_in)
);

create table if not exists public.lodging_requests (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses(id) on delete cascade,
  quote_id              uuid not null,
  room_type_id          uuid not null,
  room_type_name        text not null,
  contact_phone         text not null check (char_length(btrim(contact_phone)) between 1 and 80),
  contact_name          text,
  check_in              date not null,
  check_out             date not null,
  check_in_time         time not null,
  check_out_time        time not null,
  adults                integer not null check (adults between 1 and 500),
  children              integer not null default 0 check (children between 0 and 500),
  units_required        integer not null check (units_required between 1 and 100),
  nights                integer not null check (nights between 1 and 366),
  pricing_model         text not null check (pricing_model in (
                          'per_unit', 'per_person', 'base_plus_extra'
                        )),
  subtotal              numeric(12,2) not null check (subtotal >= 0),
  tax                   numeric(12,2) not null default 0 check (tax >= 0),
  fees                  numeric(12,2) not null default 0 check (fees >= 0),
  total                 numeric(12,2) not null check (total >= 0),
  currency              text not null
                        check (currency in ('USD','EUR','COP','PEN','MXN','BRL','CLP','ARS')),
  nightly_breakdown     jsonb not null default '[]'::jsonb
                        check (jsonb_typeof(nightly_breakdown) = 'array'),
  status                text not null default 'pending_owner'
                        check (status in (
                          'pending_owner', 'confirmed', 'rejected', 'cancelled', 'expired'
                        )),
  expires_at            timestamptz,
  confirmed_at          timestamptz,
  released_at           timestamptz,
  idempotency_key_hash  text not null
                        check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  foreign key (business_id, quote_id)
    references public.lodging_quotes(business_id, id) on delete restrict,
  foreign key (business_id, room_type_id)
    references public.lodging_room_types(business_id, id) on delete restrict,
  unique (business_id, id),
  unique (business_id, quote_id),
  unique (business_id, idempotency_key_hash),
  constraint lodging_requests_dates_check check (check_out > check_in),
  constraint lodging_requests_nights_match_dates_check
    check (nights = check_out - check_in),
  -- La columna `total check (total >= 0)` ya ocupa el nombre automático
  -- lodging_requests_total_check.
  constraint lodging_requests_total_components_check check (
    total = round(subtotal + fees, 2)
    or total = round(subtotal + tax + fees, 2)
  )
);

create table if not exists public.lodging_blocks (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  room_type_id  uuid not null,
  request_id    uuid,
  kind          text not null check (kind in ('request', 'manual', 'external', 'maintenance')),
  start_date    date not null,
  end_date      date not null,
  quantity      integer not null check (quantity between 1 and 10000),
  notes         text,
  released_at   timestamptz,
  stay_range    daterange generated always as (
                  daterange(start_date, end_date, '[)')
                ) stored,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (business_id, room_type_id)
    references public.lodging_room_types(business_id, id) on delete restrict,
  foreign key (business_id, request_id)
    references public.lodging_requests(business_id, id) on delete cascade,
  unique (business_id, id),
  unique (business_id, request_id),
  constraint lodging_blocks_dates_check check (end_date > start_date),
  constraint lodging_blocks_request_kind_check check (
    (kind = 'request' and request_id is not null)
    or (kind <> 'request' and request_id is null)
  )
);

create unique index if not exists uq_lodging_room_types_business_name
  on public.lodging_room_types (business_id, lower(name));
create index if not exists idx_lodging_room_types_business_active
  on public.lodging_room_types (business_id, active);
create index if not exists idx_lodging_rate_overrides_lookup
  on public.lodging_rate_overrides (business_id, room_type_id, rate_date);
create index if not exists idx_lodging_quotes_business_created
  on public.lodging_quotes (business_id, created_at desc);
create index if not exists idx_lodging_quotes_business_contact
  on public.lodging_quotes (business_id, contact_phone, created_at desc);
create index if not exists idx_lodging_requests_business_status_dates
  on public.lodging_requests (business_id, status, check_in, check_out);
create index if not exists idx_lodging_requests_business_contact
  on public.lodging_requests (business_id, contact_phone, created_at desc);
create index if not exists idx_lodging_requests_expiry
  on public.lodging_requests (expires_at)
  where status = 'pending_owner';
create index if not exists idx_lodging_blocks_business_request
  on public.lodging_blocks (business_id, request_id);
create index if not exists idx_lodging_blocks_active_lookup
  on public.lodging_blocks (business_id, room_type_id, start_date, end_date)
  where released_at is null;
create index if not exists idx_lodging_blocks_stay_range
  on public.lodging_blocks using gist (business_id, room_type_id, stay_range)
  where released_at is null;

create or replace function public.lodging_request_to_json(
  p_request public.lodging_requests
)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select (to_jsonb(p_request) - 'idempotency_key_hash')
    || jsonb_build_object(
      'check_in_time', to_char(p_request.check_in_time, 'HH24:MI'),
      'check_out_time', to_char(p_request.check_out_time, 'HH24:MI')
    );
$$;

-- Garantía física del inventario agregado. Cualquier INSERT/UPDATE directo,
-- incluso con service_role, toma el mismo lock que las RPC y no puede superar
-- total_units en ninguna noche del rango.
create or replace function public.enforce_lodging_block_capacity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_total_units integer;
  v_request public.lodging_requests%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.business_id::text || ':lodging', 0));

  if tg_op = 'UPDATE'
     and old.kind = 'request'
     and (
       new.kind <> old.kind
       or new.request_id is distinct from old.request_id
       or new.business_id is distinct from old.business_id
       or new.room_type_id is distinct from old.room_type_id
       or new.start_date is distinct from old.start_date
       or new.end_date is distinct from old.end_date
       or new.quantity is distinct from old.quantity
     ) then
    raise exception using
      errcode = '42501',
      message = 'La identidad de un bloqueo de solicitud es inmutable';
  end if;

  if new.released_at is not null then
    if new.kind = 'request' then
      select request.*
      into v_request
      from public.lodging_requests as request
      where request.business_id = new.business_id
        and request.id = new.request_id
      for share;

      if not found or v_request.status not in (
        'rejected', 'cancelled', 'expired'
      ) then
        raise exception using
          errcode = '42501',
          message = 'Un bloqueo de solicitud solo se libera mediante el estado de la solicitud';
      end if;
    end if;
    return new;
  end if;

  select room_type.total_units
  into v_total_units
  from public.lodging_room_types as room_type
  where room_type.business_id = new.business_id
    and room_type.id = new.room_type_id
  for share;

  if not found then
    raise exception using errcode = '23503', message = 'El tipo de habitación no pertenece al negocio';
  end if;

  if new.kind = 'request' then
    select request.*
    into v_request
    from public.lodging_requests as request
    where request.business_id = new.business_id
      and request.id = new.request_id
      and request.room_type_id = new.room_type_id
      and request.check_in = new.start_date
      and request.check_out = new.end_date
      and request.units_required = new.quantity
    for share;

    if not found or not (
      v_request.status = 'confirmed'
      or (
        v_request.status = 'pending_owner'
        and v_request.expires_at is not null
        and v_request.expires_at > now()
      )
    ) then
      raise exception using errcode = '23514', message = 'El bloqueo no coincide con una solicitud activa';
    end if;
  end if;

  if exists (
    select 1
    from generate_series(new.start_date, new.end_date - 1, interval '1 day') as occupied_day
    where coalesce((
      select sum(block.quantity)
      from public.lodging_blocks as block
      left join public.lodging_requests as request
        on request.business_id = block.business_id
       and request.id = block.request_id
      where block.business_id = new.business_id
        and block.room_type_id = new.room_type_id
        and block.id <> new.id
        and block.released_at is null
        and block.start_date <= occupied_day::date
        and block.end_date > occupied_day::date
        and (
          block.request_id is null
          or request.status = 'confirmed'
          or (
            request.status = 'pending_owner'
            and request.expires_at is not null
            and request.expires_at > now()
          )
        )
    ), 0) + new.quantity > v_total_units
  ) then
    raise exception using errcode = '23P01', message = 'No hay inventario suficiente para todo el rango';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.set_lodging_request_status(
  p_business_id uuid,
  p_request_id uuid,
  p_status text
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_request public.lodging_requests%rowtype;
  v_release boolean;
begin
  if p_business_id is null or p_request_id is null then
    raise exception using errcode = '22023', message = 'Negocio y solicitud son obligatorios';
  end if;
  if p_status not in (
    'confirmed', 'rejected', 'cancelled', 'expired'
  ) then
    return jsonb_build_object('result', 'invalid_transition', 'request', null);
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text || ':lodging', 0));
  perform public.expire_lodging_holds(p_business_id);

  select request.*
  into v_request
  from public.lodging_requests as request
  where request.business_id = p_business_id
    and request.id = p_request_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found', 'request', null);
  end if;
  if v_request.status = 'expired' then
    return jsonb_build_object(
      'result', 'expired',
      'changed', false,
      'request', public.lodging_request_to_json(v_request)
    );
  end if;
  if v_request.status = p_status then
    return jsonb_build_object(
      'result', 'unchanged',
      'changed', false,
      'request', public.lodging_request_to_json(v_request)
    );
  end if;

  if not (
    (v_request.status = 'pending_owner' and p_status in (
      'confirmed', 'rejected', 'cancelled', 'expired'
    ))
    or (v_request.status = 'confirmed' and p_status = 'cancelled')
  ) then
    return jsonb_build_object(
      'result', 'invalid_transition',
      'request', public.lodging_request_to_json(v_request)
    );
  end if;

  v_release := p_status in (
    'rejected', 'cancelled', 'expired'
  );

  update public.lodging_requests as request
  set status = p_status,
      expires_at = case when p_status = 'confirmed' then null else request.expires_at end,
      confirmed_at = case
        when p_status = 'confirmed' then coalesce(request.confirmed_at, now())
        else request.confirmed_at
      end,
      released_at = case
        when v_release then coalesce(request.released_at, now())
        else request.released_at
      end,
      updated_at = now()
  where request.business_id = p_business_id
    and request.id = p_request_id
  returning * into v_request;

  if v_release then
    update public.lodging_blocks as block
    set released_at = coalesce(block.released_at, now()),
        updated_at = now()
    where block.business_id = p_business_id
      and block.request_id = p_request_id
      and block.released_at is null;
  end if;

  return jsonb_build_object(
    'result', 'updated',
    'changed', true,
    'request', public.lodging_request_to_json(v_request)
  );
end;
$$;

create or replace function public.upsert_lodging_block_if_available(
  p_business_id uuid,
  p_room_type_id uuid,
  p_kind text,
  p_start_date date,
  p_end_date date,
  p_quantity integer,
  p_notes text default null,
  p_block_id uuid default null
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_block public.lodging_blocks%rowtype;
begin
  if p_business_id is null or p_room_type_id is null then
    raise exception using errcode = '22023', message = 'Negocio y tipo de habitación son obligatorios';
  end if;
  if p_kind not in ('manual', 'external', 'maintenance') or p_kind is null then
    return jsonb_build_object('result', 'forbidden', 'block', null);
  end if;
  if p_start_date is null or p_end_date is null or p_end_date <= p_start_date then
    raise exception using errcode = '22023', message = 'El rango del bloqueo es inválido';
  end if;
  if coalesce(p_quantity, 0) not between 1 and 10000 then
    raise exception using errcode = '22023', message = 'La cantidad del bloqueo es inválida';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text || ':lodging', 0));
  perform public.expire_lodging_holds(p_business_id);

  if not exists (
    select 1
    from public.lodging_room_types as room_type
    where room_type.business_id = p_business_id
      and room_type.id = p_room_type_id
  ) then
    return jsonb_build_object('result', 'not_found', 'block', null);
  end if;

  if p_block_id is null then
    insert into public.lodging_blocks (
      business_id, room_type_id, request_id, kind,
      start_date, end_date, quantity, notes
    ) values (
      p_business_id, p_room_type_id, null, p_kind,
      p_start_date, p_end_date, p_quantity, nullif(btrim(p_notes), '')
    ) returning * into v_block;

    return jsonb_build_object('result', 'created', 'block', to_jsonb(v_block));
  end if;

  select block.*
  into v_block
  from public.lodging_blocks as block
  where block.business_id = p_business_id
    and block.id = p_block_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found', 'block', null);
  end if;
  if v_block.kind = 'request' or v_block.request_id is not null then
    return jsonb_build_object('result', 'forbidden', 'block', null);
  end if;

  update public.lodging_blocks as block
  set room_type_id = p_room_type_id,
      kind = p_kind,
      start_date = p_start_date,
      end_date = p_end_date,
      quantity = p_quantity,
      notes = nullif(btrim(p_notes), ''),
      released_at = null,
      updated_at = now()
  where block.business_id = p_business_id
    and block.id = p_block_id
    and block.request_id is null
    and block.kind <> 'request'
  returning * into v_block;

  return jsonb_build_object('result', 'updated', 'block', to_jsonb(v_block));
exception
  when exclusion_violation then
    return jsonb_build_object('result', 'unavailable', 'block', null);
end;
$$;

create or replace function public.release_lodging_block(
  p_business_id uuid,
  p_block_id uuid
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_block public.lodging_blocks%rowtype;
begin
  if p_business_id is null or p_block_id is null then
    raise exception using errcode = '22023', message = 'Negocio y bloqueo son obligatorios';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text || ':lodging', 0));

  select block.*
  into v_block
  from public.lodging_blocks as block
  where block.business_id = p_business_id
    and block.id = p_block_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found', 'block', null);
  end if;
  if v_block.kind = 'request' or v_block.request_id is not null then
    return jsonb_build_object('result', 'forbidden', 'block', null);
  end if;

  update public.lodging_blocks as block
  set released_at = coalesce(block.released_at, now()),
      updated_at = now()
  where block.business_id = p_business_id
    and block.id = p_block_id
    and block.request_id is null
    and block.kind <> 'request'
  returning * into v_block;

  return jsonb_build_object('result', 'released', 'block', to_jsonb(v_block));
end;
$$;


create or replace function public.create_lodging_request_if_available(
  p_business_id uuid,
  p_quote_id uuid,
  p_room_type_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_idempotency_key text,
  p_notes text default null
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_business public.businesses%rowtype;
  v_settings public.lodging_settings%rowtype;
  v_quote public.lodging_quotes%rowtype;
  v_room_type public.lodging_room_types%rowtype;
  v_override public.lodging_rate_overrides%rowtype;
  v_request public.lodging_requests%rowtype;
  v_existing_request public.lodging_requests%rowtype;
  v_block public.lodging_blocks%rowtype;
  v_snapshot jsonb;
  v_breakdown jsonb := '[]'::jsonb;
  v_idempotency_hash text;
  v_total_guests integer;
  v_units_required integer;
  v_available_units integer;
  v_stay_date date;
  v_has_override boolean;
  v_closed boolean;
  v_effective_base numeric(12,2);
  v_effective_extra numeric(12,2);
  v_effective_child numeric(12,2);
  v_extra_adults integer;
  v_line_total numeric(12,2);
  v_subtotal numeric(12,2) := 0;
  v_tax numeric(12,2);
  v_fees numeric(12,2);
  v_total numeric(12,2);
begin
  if p_business_id is null or p_quote_id is null or p_room_type_id is null then
    raise exception using errcode = '22023', message = 'Negocio, cotización y tipo de habitación son obligatorios';
  end if;
  if nullif(btrim(p_contact_phone), '') is null
     or char_length(btrim(p_contact_phone)) > 80 then
    raise exception using errcode = '22023', message = 'El contacto es obligatorio';
  end if;
  if nullif(p_idempotency_key, '') is null
     or char_length(p_idempotency_key) not between 1 and 512 then
    raise exception using errcode = '22023', message = 'La clave de idempotencia es obligatoria';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text || ':lodging', 0));

  select business.*
  into v_business
  from public.businesses as business
  where business.id = p_business_id
  for share;

  if not found then
    raise exception using errcode = '23503', message = 'El negocio no existe';
  end if;
  if v_business.lodging_enabled is distinct from true
     or v_business.active is distinct from true
     or v_business.suspended is true then
    raise exception using errcode = '42501', message = 'El módulo de hospedaje no está habilitado';
  end if;

  insert into public.lodging_settings (business_id)
  values (p_business_id)
  on conflict (business_id) do nothing;

  select settings.*
  into v_settings
  from public.lodging_settings as settings
  where settings.business_id = p_business_id
  for share;

  perform public.expire_lodging_holds(p_business_id);

  v_idempotency_hash := encode(
    sha256(convert_to(p_idempotency_key, 'UTF8')),
    'hex'
  );

  select request.*
  into v_existing_request
  from public.lodging_requests as request
  where request.business_id = p_business_id
    and request.idempotency_key_hash = v_idempotency_hash;

  if found then
    if v_existing_request.quote_id <> p_quote_id
       or v_existing_request.room_type_id <> p_room_type_id
       or v_existing_request.contact_phone <> btrim(p_contact_phone) then
      raise exception using errcode = '22023', message = 'La clave de idempotencia ya fue usada con otros datos';
    end if;
    if v_existing_request.status = 'pending_owner' then
      return jsonb_build_object(
        'result', 'duplicate',
        'request', public.lodging_request_to_json(v_existing_request)
      );
    end if;
    if v_existing_request.status = 'expired' then
      return jsonb_build_object('result', 'quote_expired', 'request', null);
    end if;
    return jsonb_build_object(
      'result', 'invalid_transition',
      'request', public.lodging_request_to_json(v_existing_request)
    );
  end if;

  select quote.*
  into v_quote
  from public.lodging_quotes as quote
  where quote.business_id = p_business_id
    and quote.id = p_quote_id
  for update;

  if not found
     or v_quote.status = 'expired'
     or v_quote.expires_at <= now() then
    return jsonb_build_object('result', 'quote_expired', 'request', null);
  end if;
  if v_quote.contact_phone <> btrim(p_contact_phone)
     or (
       nullif(btrim(p_contact_name), '') is not null
       and v_quote.contact_name is not null
       and nullif(btrim(p_contact_name), '') <> v_quote.contact_name
     ) then
    raise exception using errcode = '42501', message = 'La cotización no pertenece al contacto';
  end if;

  if v_quote.status = 'accepted' then
    select request.*
    into v_existing_request
    from public.lodging_requests as request
    where request.business_id = p_business_id
      and request.quote_id = p_quote_id;

    if found and v_existing_request.status = 'pending_owner' then
      return jsonb_build_object(
        'result', 'duplicate',
        'request', public.lodging_request_to_json(v_existing_request)
      );
    end if;
    if found and v_existing_request.status = 'expired' then
      return jsonb_build_object('result', 'quote_expired', 'request', null);
    end if;
    return jsonb_build_object('result', 'invalid_transition', 'request', null);
  end if;

  select option_value
  into v_snapshot
  from jsonb_array_elements(v_quote.options) as option_value
  where option_value ->> 'room_type_id' = p_room_type_id::text
  limit 1;

  if not found then
    return jsonb_build_object('result', 'room_type_not_found', 'request', null);
  end if;

  select room_type.*
  into v_room_type
  from public.lodging_room_types as room_type
  where room_type.business_id = p_business_id
    and room_type.id = p_room_type_id
    and room_type.active is true
  for share;

  if not found then
    return jsonb_build_object('result', 'room_type_not_found', 'request', null);
  end if;
  if v_room_type.pricing_model = 'manual' then
    return jsonb_build_object('result', 'manual_quote', 'request', null);
  end if;

  v_total_guests := v_quote.adults + v_quote.children;
  v_units_required := greatest(
    v_quote.rooms_count,
    ceil(v_total_guests::numeric / v_room_type.max_guests)::integer
  );

  v_closed := exists (
    select 1
    from public.lodging_rate_overrides as override
    where override.business_id = p_business_id
      and override.room_type_id = p_room_type_id
      and override.rate_date >= v_quote.check_in
      and override.rate_date < v_quote.check_out
      and override.closed is true
  );
  if v_closed then
    return jsonb_build_object('result', 'unavailable', 'request', null);
  end if;

  select coalesce(min(
    v_room_type.total_units - coalesce((
      select sum(block.quantity)
      from public.lodging_blocks as block
      left join public.lodging_requests as request
        on request.business_id = block.business_id
       and request.id = block.request_id
      where block.business_id = p_business_id
        and block.room_type_id = p_room_type_id
        and block.released_at is null
        and block.start_date <= occupied_day::date
        and block.end_date > occupied_day::date
        and (
          block.request_id is null
          or request.status = 'confirmed'
          or (
            request.status = 'pending_owner'
            and request.expires_at is not null
            and request.expires_at > now()
          )
        )
    ), 0)
  ), v_room_type.total_units)::integer
  into v_available_units
  from generate_series(
    v_quote.check_in,
    v_quote.check_out - 1,
    interval '1 day'
  ) as occupied_day;

  if v_units_required > v_room_type.total_units
     or v_available_units < v_units_required then
    return jsonb_build_object('result', 'unavailable', 'request', null);
  end if;

  for v_stay_date in
    select day_value::date
    from generate_series(
      v_quote.check_in,
      v_quote.check_out - 1,
      interval '1 day'
    ) as day_value
  loop
    v_has_override := false;
    select override.*
    into v_override
    from public.lodging_rate_overrides as override
    where override.business_id = p_business_id
      and override.room_type_id = p_room_type_id
      and override.rate_date = v_stay_date;
    v_has_override := found;

    v_effective_base := case
      when v_has_override and v_override.base_rate is not null
        then v_override.base_rate
      when extract(isodow from v_stay_date)::integer in (6, 7)
           and v_room_type.weekend_rate is not null
        then v_room_type.weekend_rate
      else v_room_type.base_rate
    end;
    v_effective_extra := case
      when v_has_override and v_override.extra_adult_rate is not null
        then v_override.extra_adult_rate
      else v_room_type.extra_adult_rate
    end;
    v_effective_child := case
      when v_has_override and v_override.child_rate is not null
        then v_override.child_rate
      else v_room_type.child_rate
    end;
    v_extra_adults := greatest(
      v_quote.adults - (v_room_type.base_occupancy * v_units_required),
      0
    );
    v_line_total := round(case v_room_type.pricing_model
      when 'per_unit' then v_effective_base * v_units_required
      when 'per_person' then
        (v_effective_base * v_quote.adults)
        + (v_effective_child * v_quote.children)
      when 'base_plus_extra' then
        (v_effective_base * v_units_required)
        + (v_effective_extra * v_extra_adults)
        + (v_effective_child * v_quote.children)
    end, 2);

    v_subtotal := v_subtotal + v_line_total;
    v_breakdown := v_breakdown || jsonb_build_array(jsonb_build_object(
      'date', v_stay_date,
      'base_rate', v_effective_base,
      'extra_adult_rate', v_effective_extra,
      'child_rate', v_effective_child,
      'extra_adults', v_extra_adults,
      'line_total', v_line_total
    ));
  end loop;

  v_subtotal := round(v_subtotal, 2);
  v_fees := round(v_settings.service_fee, 2);
  if v_settings.prices_include_tax then
    v_tax := case
      when v_settings.tax_rate = 0 then 0
      else round(v_subtotal - (v_subtotal / (1 + v_settings.tax_rate)), 2)
    end;
    v_total := round(v_subtotal + v_fees, 2);
  else
    v_tax := round(v_subtotal * v_settings.tax_rate, 2);
    v_total := round(v_subtotal + v_tax + v_fees, 2);
  end if;

  -- Igual que pedidos: los montos se recalculan en PostgreSQL y deben seguir
  -- coincidiendo con el snapshot que el huésped aceptó.
  if v_quote.currency is distinct from v_settings.currency
     or (v_snapshot ->> 'units_required')::integer is distinct from v_units_required
     or (v_snapshot ->> 'subtotal')::numeric is distinct from v_subtotal
     or (v_snapshot ->> 'tax')::numeric is distinct from v_tax
     or (v_snapshot ->> 'fees')::numeric is distinct from v_fees
     or (v_snapshot ->> 'total')::numeric is distinct from v_total then
    update public.lodging_quotes
    set status = 'expired'
    where business_id = p_business_id and id = p_quote_id;
    return jsonb_build_object('result', 'quote_expired', 'request', null);
  end if;

  insert into public.lodging_requests (
    business_id, quote_id, room_type_id, room_type_name,
    contact_phone, contact_name, check_in, check_out,
    check_in_time, check_out_time, adults, children,
    units_required, nights, pricing_model, subtotal, tax, fees, total,
    currency, nightly_breakdown, status, expires_at,
    idempotency_key_hash, notes
  ) values (
    p_business_id, p_quote_id, p_room_type_id, v_room_type.name,
    btrim(p_contact_phone), coalesce(nullif(btrim(p_contact_name), ''), v_quote.contact_name),
    v_quote.check_in, v_quote.check_out,
    v_quote.check_in_time, v_quote.check_out_time,
    v_quote.adults, v_quote.children,
    v_units_required, v_quote.nights, v_room_type.pricing_model,
    v_subtotal, v_tax, v_fees, v_total, v_settings.currency, v_breakdown,
    'pending_owner', now() + make_interval(mins => v_settings.hold_minutes),
    v_idempotency_hash, nullif(btrim(p_notes), '')
  ) returning * into v_request;

  insert into public.lodging_blocks (
    business_id, room_type_id, request_id, kind,
    start_date, end_date, quantity, notes
  ) values (
    p_business_id, p_room_type_id, v_request.id, 'request',
    v_quote.check_in, v_quote.check_out, v_units_required,
    'Hold pendiente de confirmación del dueño'
  ) returning * into v_block;

  update public.lodging_quotes
  set status = 'accepted', accepted_at = now()
  where business_id = p_business_id and id = p_quote_id;

  return jsonb_build_object(
    'result', 'created',
    'request', public.lodging_request_to_json(v_request)
  );
exception
  when exclusion_violation then
    return jsonb_build_object('result', 'unavailable', 'request', null);
  when unique_violation then
    select request.*
    into v_existing_request
    from public.lodging_requests as request
    where request.business_id = p_business_id
      and (
        request.idempotency_key_hash = v_idempotency_hash
        or request.quote_id = p_quote_id
      )
    order by request.created_at
    limit 1;

    if found and v_existing_request.status = 'pending_owner' then
      return jsonb_build_object(
        'result', 'duplicate',
        'request', public.lodging_request_to_json(v_existing_request)
      );
    end if;
    if found and v_existing_request.status = 'expired' then
      return jsonb_build_object('result', 'quote_expired', 'request', null);
    end if;
    return jsonb_build_object('result', 'invalid_transition', 'request', null);
end;
$$;


drop trigger if exists trg_lodging_blocks_capacity on public.lodging_blocks;
create trigger trg_lodging_blocks_capacity
before insert or update on public.lodging_blocks
for each row execute function public.enforce_lodging_block_capacity();

-- Evita reducir la capacidad por debajo de compromisos futuros activos. Archivar
-- solo impide nuevas ofertas; no libera ni modifica reservas existentes.
create or replace function public.enforce_lodging_room_type_capacity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.total_units = old.total_units and new.active = old.active then
    new.updated_at := now();
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.business_id::text || ':lodging', 0));

  if new.total_units < old.total_units and exists (
    select 1
    from (
      select occupied_day::date, sum(block.quantity) as occupied_units
      from public.lodging_blocks as block
      left join public.lodging_requests as request
        on request.business_id = block.business_id
       and request.id = block.request_id
      cross join lateral generate_series(
        greatest(
          block.start_date,
          (now() at time zone 'America/Guayaquil')::date
        ),
        block.end_date - 1,
        interval '1 day'
      ) as occupied_day
      where block.business_id = new.business_id
        and block.room_type_id = new.id
        and block.released_at is null
        and block.end_date > (now() at time zone 'America/Guayaquil')::date
        and (
          block.request_id is null
          or request.status = 'confirmed'
          or (
            request.status = 'pending_owner'
            and request.expires_at is not null
            and request.expires_at > now()
          )
        )
      group by occupied_day::date
      having sum(block.quantity) > new.total_units
    ) as over_capacity
  ) then
    raise exception using errcode = '23514', message = 'La capacidad nueva es menor que el inventario ya comprometido';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_lodging_room_types_capacity on public.lodging_room_types;
create trigger trg_lodging_room_types_capacity
before update on public.lodging_room_types
for each row execute function public.enforce_lodging_room_type_capacity();

-- Las mutaciones de configuración usan el mismo lock que cotización/hold. Así
-- una solicitud nunca puede mezclar tarifas anteriores y nuevas dentro del
-- cálculo por noches.
create or replace function public.lock_lodging_configuration()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_business_id uuid;
begin
  v_business_id := case when tg_op = 'DELETE' then old.business_id else new.business_id end;
  perform pg_advisory_xact_lock(hashtextextended(v_business_id::text || ':lodging', 0));

  if tg_op = 'DELETE' then
    return old;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_lodging_settings_configuration_lock
  on public.lodging_settings;
create trigger trg_lodging_settings_configuration_lock
before insert or update or delete on public.lodging_settings
for each row execute function public.lock_lodging_configuration();

drop trigger if exists trg_lodging_room_types_configuration_lock
  on public.lodging_room_types;
create trigger trg_lodging_room_types_configuration_lock
before insert or update or delete on public.lodging_room_types
for each row execute function public.lock_lodging_configuration();

drop trigger if exists trg_lodging_rate_overrides_configuration_lock
  on public.lodging_rate_overrides;
create trigger trg_lodging_rate_overrides_configuration_lock
before insert or update or delete on public.lodging_rate_overrides
for each row execute function public.lock_lodging_configuration();

create or replace function public.lock_business_lodging_toggle()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.lodging_enabled is distinct from old.lodging_enabled then
    perform pg_advisory_xact_lock(hashtextextended(new.id::text || ':lodging', 0));
  end if;

  if old.lodging_enabled is true
     and new.lodging_enabled is false
     and exists (
       select 1
       from public.lodging_requests as request
       join public.lodging_blocks as block
         on block.business_id = request.business_id
        and block.request_id = request.id
       where request.business_id = new.id
         and request.check_out >= (now() at time zone 'America/Guayaquil')::date
         and block.released_at is null
         and (
           request.status = 'confirmed'
           or (
             request.status = 'pending_owner'
             and request.expires_at is not null
             and request.expires_at > now()
           )
         )
     ) then
    raise exception using
      errcode = '23514',
      message = 'No se puede deshabilitar hospedaje con solicitudes o estadías activas';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_businesses_lodging_toggle_lock on public.businesses;
create trigger trg_businesses_lodging_toggle_lock
before update of lodging_enabled on public.businesses
for each row execute function public.lock_business_lodging_toggle();

-- Limpieza explícita e idempotente de holds. La disponibilidad también ignora
-- holds vencidos aunque este mantenimiento no llegue a ejecutarse.
create or replace function public.expire_lodging_holds(p_business_id uuid)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_expired_count integer := 0;
  v_expired_ids uuid[] := array[]::uuid[];
begin
  if p_business_id is null then
    raise exception using errcode = '22023', message = 'El negocio es obligatorio';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text || ':lodging', 0));

  with expired_requests as (
    update public.lodging_requests as request
    set status = 'expired',
        released_at = coalesce(request.released_at, now()),
        updated_at = now()
    where request.business_id = p_business_id
      and request.status = 'pending_owner'
      and request.expires_at is not null
      and request.expires_at <= now()
    returning request.id
  )
  select coalesce(array_agg(id), array[]::uuid[])
  into v_expired_ids
  from expired_requests;

  v_expired_count := cardinality(v_expired_ids);

  -- Sentencia separada: el trigger de blocks ya observa status='expired'.
  if v_expired_count > 0 then
    update public.lodging_blocks as block
    set released_at = coalesce(block.released_at, now()),
        updated_at = now()
    where block.business_id = p_business_id
      and block.request_id = any(v_expired_ids)
      and block.released_at is null;
  end if;

  update public.lodging_quotes as quote
  set status = 'expired'
  where quote.business_id = p_business_id
    and quote.status = 'quoted'
    and quote.expires_at <= now();

  return v_expired_count;
end;
$$;

-- Cotiza todas las opciones activas. Los sábados y domingos (ISO 6/7) usan
-- weekend_rate cuando existe; un override de fecha siempre tiene prioridad.
create or replace function public.quote_lodging_options(
  p_business_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_check_in date,
  p_check_out date,
  p_adults integer,
  p_children integer,
  p_rooms_count integer default 1,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_business public.businesses%rowtype;
  v_settings public.lodging_settings%rowtype;
  v_quote public.lodging_quotes%rowtype;
  v_existing_quote public.lodging_quotes%rowtype;
  v_room_type public.lodging_room_types%rowtype;
  v_override public.lodging_rate_overrides%rowtype;
  v_options jsonb := '[]'::jsonb;
  v_breakdown jsonb;
  v_option jsonb;
  v_idempotency_hash text;
  v_nights integer;
  v_total_guests integer;
  v_units_required integer;
  v_available_units integer;
  v_stay_date date;
  v_has_override boolean;
  v_closed boolean;
  v_effective_base numeric(12,2);
  v_effective_extra numeric(12,2);
  v_effective_child numeric(12,2);
  v_extra_adults integer;
  v_line_total numeric(12,2);
  v_subtotal numeric(12,2);
  v_tax numeric(12,2);
  v_fees numeric(12,2);
  v_total numeric(12,2);
begin
  if p_business_id is null then
    raise exception using errcode = '22023', message = 'El negocio es obligatorio';
  end if;
  if nullif(btrim(p_contact_phone), '') is null
     or char_length(btrim(p_contact_phone)) > 80 then
    raise exception using errcode = '22023', message = 'El contacto es obligatorio';
  end if;
  if p_check_in is null or p_check_out is null or p_check_out <= p_check_in then
    raise exception using errcode = '22023', message = 'El rango de hospedaje es inválido';
  end if;
  if p_check_in < (now() at time zone 'America/Guayaquil')::date then
    raise exception using errcode = '22023', message = 'La fecha de entrada no puede estar en el pasado';
  end if;

  v_nights := p_check_out - p_check_in;
  if v_nights not between 1 and 366 then
    raise exception using errcode = '22023', message = 'La estadía debe tener entre 1 y 366 noches';
  end if;
  if coalesce(p_adults, 0) not between 1 and 500
     or coalesce(p_children, -1) not between 0 and 500 then
    raise exception using errcode = '22023', message = 'La cantidad de huéspedes es inválida';
  end if;
  if coalesce(p_rooms_count, 0) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'La cantidad mínima de habitaciones es inválida';
  end if;
  if p_idempotency_key is not null
     and char_length(p_idempotency_key) not between 1 and 512 then
    raise exception using errcode = '22023', message = 'La clave de idempotencia es inválida';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text || ':lodging', 0));

  select business.*
  into v_business
  from public.businesses as business
  where business.id = p_business_id
  for share;

  if not found then
    raise exception using errcode = '23503', message = 'El negocio no existe';
  end if;
  if v_business.lodging_enabled is distinct from true
     or v_business.active is distinct from true
     or v_business.suspended is true then
    raise exception using errcode = '42501', message = 'El módulo de hospedaje no está habilitado';
  end if;

  -- Compatibilidad para negocios habilitados antes de guardar configuración.
  insert into public.lodging_settings (business_id)
  values (p_business_id)
  on conflict (business_id) do nothing;

  select settings.*
  into v_settings
  from public.lodging_settings as settings
  where settings.business_id = p_business_id
  for share;

  perform public.expire_lodging_holds(p_business_id);

  if p_idempotency_key is not null then
    v_idempotency_hash := encode(
      sha256(convert_to(p_idempotency_key, 'UTF8')),
      'hex'
    );

    select quote.*
    into v_existing_quote
    from public.lodging_quotes as quote
    where quote.business_id = p_business_id
      and quote.idempotency_key_hash = v_idempotency_hash;

    if found then
      if v_existing_quote.contact_phone <> btrim(p_contact_phone)
         or v_existing_quote.check_in <> p_check_in
         or v_existing_quote.check_out <> p_check_out
         or v_existing_quote.adults <> p_adults
         or v_existing_quote.children <> p_children
         or v_existing_quote.rooms_count <> p_rooms_count then
        raise exception using errcode = '22023', message = 'La clave de idempotencia ya fue usada con otros datos';
      end if;

      if v_existing_quote.status = 'expired'
         or v_existing_quote.expires_at <= now() then
        return jsonb_build_object('result', 'quote_expired', 'quote', null, 'options', '[]'::jsonb);
      end if;
      if v_existing_quote.status = 'accepted' then
        return jsonb_build_object('result', 'invalid_transition', 'quote', null, 'options', '[]'::jsonb);
      end if;

      return jsonb_build_object(
        'result', 'quoted',
        'duplicate', true,
        'quote', (to_jsonb(v_existing_quote) - 'options' - 'idempotency_key_hash')
          || jsonb_build_object(
            'check_in_time', to_char(v_existing_quote.check_in_time, 'HH24:MI'),
            'check_out_time', to_char(v_existing_quote.check_out_time, 'HH24:MI')
          ),
        'options', v_existing_quote.options
      );
    end if;
  end if;

  v_total_guests := p_adults + p_children;

  for v_room_type in
    select room_type.*
    from public.lodging_room_types as room_type
    where room_type.business_id = p_business_id
      and room_type.active is true
    order by room_type.name, room_type.id
  loop
    v_units_required := greatest(
      p_rooms_count,
      ceil(v_total_guests::numeric / v_room_type.max_guests)::integer
    );

    select coalesce(min(
      v_room_type.total_units - coalesce((
        select sum(block.quantity)
        from public.lodging_blocks as block
        left join public.lodging_requests as request
          on request.business_id = block.business_id
         and request.id = block.request_id
        where block.business_id = p_business_id
          and block.room_type_id = v_room_type.id
          and block.released_at is null
          and block.start_date <= occupied_day::date
          and block.end_date > occupied_day::date
          and (
            block.request_id is null
            or request.status = 'confirmed'
            or (
              request.status = 'pending_owner'
              and request.expires_at is not null
              and request.expires_at > now()
            )
          )
      ), 0)
    ), v_room_type.total_units)::integer
    into v_available_units
    from generate_series(p_check_in, p_check_out - 1, interval '1 day') as occupied_day;

    v_closed := exists (
      select 1
      from public.lodging_rate_overrides as override
      where override.business_id = p_business_id
        and override.room_type_id = v_room_type.id
        and override.rate_date >= p_check_in
        and override.rate_date < p_check_out
        and override.closed is true
    );

    v_breakdown := '[]'::jsonb;
    v_subtotal := null;
    v_tax := null;
    v_fees := null;
    v_total := null;

    if v_room_type.pricing_model <> 'manual' then
      v_subtotal := 0;

      for v_stay_date in
        select day_value::date
        from generate_series(p_check_in, p_check_out - 1, interval '1 day') as day_value
      loop
        v_has_override := false;
        select override.*
        into v_override
        from public.lodging_rate_overrides as override
        where override.business_id = p_business_id
          and override.room_type_id = v_room_type.id
          and override.rate_date = v_stay_date;
        v_has_override := found;

        v_effective_base := case
          when v_has_override and v_override.base_rate is not null
            then v_override.base_rate
          when extract(isodow from v_stay_date)::integer in (6, 7)
               and v_room_type.weekend_rate is not null
            then v_room_type.weekend_rate
          else v_room_type.base_rate
        end;
        v_effective_extra := case
          when v_has_override and v_override.extra_adult_rate is not null
            then v_override.extra_adult_rate
          else v_room_type.extra_adult_rate
        end;
        v_effective_child := case
          when v_has_override and v_override.child_rate is not null
            then v_override.child_rate
          else v_room_type.child_rate
        end;

        v_extra_adults := greatest(
          p_adults - (v_room_type.base_occupancy * v_units_required),
          0
        );
        v_line_total := round(case v_room_type.pricing_model
          when 'per_unit' then v_effective_base * v_units_required
          when 'per_person' then
            (v_effective_base * p_adults) + (v_effective_child * p_children)
          when 'base_plus_extra' then
            (v_effective_base * v_units_required)
            + (v_effective_extra * v_extra_adults)
            + (v_effective_child * p_children)
        end, 2);

        v_subtotal := v_subtotal + v_line_total;
        v_breakdown := v_breakdown || jsonb_build_array(jsonb_build_object(
          'date', v_stay_date,
          'base_rate', v_effective_base,
          'extra_adult_rate', v_effective_extra,
          'child_rate', v_effective_child,
          'extra_adults', v_extra_adults,
          'line_total', v_line_total
        ));
      end loop;

      v_subtotal := round(v_subtotal, 2);
      v_fees := round(v_settings.service_fee, 2);
      if v_settings.prices_include_tax then
        v_tax := case
          when v_settings.tax_rate = 0 then 0
          else round(v_subtotal - (v_subtotal / (1 + v_settings.tax_rate)), 2)
        end;
        v_total := round(v_subtotal + v_fees, 2);
      else
        v_tax := round(v_subtotal * v_settings.tax_rate, 2);
        v_total := round(v_subtotal + v_tax + v_fees, 2);
      end if;
    end if;

    v_option := jsonb_build_object(
      'room_type_id', v_room_type.id,
      'name', v_room_type.name,
      'description', v_room_type.description,
      'amenities', to_jsonb(v_room_type.amenities),
      'media_urls', to_jsonb(v_room_type.media_urls),
      'pricing_model', v_room_type.pricing_model,
      'total_units', v_room_type.total_units,
      'available_units', greatest(v_available_units, 0),
      'units_required', v_units_required,
      'base_occupancy', v_room_type.base_occupancy,
      'max_guests', v_room_type.max_guests,
      'nights', v_nights,
      'check_in_time', to_char(v_settings.check_in_time, 'HH24:MI'),
      'check_out_time', to_char(v_settings.check_out_time, 'HH24:MI'),
      'currency', v_settings.currency,
      'subtotal', v_subtotal,
      'tax', v_tax,
      'fees', v_fees,
      'total', v_total,
      'prices_include_tax', v_settings.prices_include_tax,
      'nightly_rates', v_breakdown,
      'nightly_breakdown', v_breakdown,
      'available', (
        not v_closed
        and v_available_units >= v_units_required
        and v_units_required <= v_room_type.total_units
      ),
      'closed', v_closed
    );
    if not v_closed
       and v_available_units >= v_units_required
       and v_units_required <= v_room_type.total_units then
      v_options := v_options || jsonb_build_array(v_option);
    end if;
  end loop;

  insert into public.lodging_quotes (
    business_id, contact_phone, contact_name, check_in, check_out,
    check_in_time, check_out_time,
    adults, children, rooms_count, nights, currency, options,
    status, expires_at, idempotency_key_hash
  ) values (
    p_business_id, btrim(p_contact_phone), nullif(btrim(p_contact_name), ''),
    p_check_in, p_check_out, v_settings.check_in_time, v_settings.check_out_time,
    p_adults, p_children, p_rooms_count, v_nights,
    v_settings.currency, v_options, 'quoted',
    now() + make_interval(mins => v_settings.quote_expiry_minutes),
    v_idempotency_hash
  ) returning * into v_quote;

  return jsonb_build_object(
    'result', 'quoted',
    'quote', (to_jsonb(v_quote) - 'options' - 'idempotency_key_hash')
      || jsonb_build_object(
        'check_in_time', to_char(v_quote.check_in_time, 'HH24:MI'),
        'check_out_time', to_char(v_quote.check_out_time, 'HH24:MI')
      ),
    'options', v_options
  );
end;
$$;

-- Mantiene el onboarding completo en una sola transacción e incorpora la
-- capacidad de hospedaje.
create or replace function public.create_business_onboarding(
  p_business jsonb,
  p_client_email text default null,
  p_password_hash text default null,
  p_monthly_rate numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business public.businesses%rowtype;
  v_name text := btrim(coalesce(p_business ->> 'name', ''));
  v_slug text := btrim(coalesce(p_business ->> 'slug', ''));
  v_whatsapp_number text := btrim(coalesce(p_business ->> 'whatsapp_number', ''));
  v_client_email text := nullif(btrim(coalesce(p_client_email, '')), '');
  v_password_hash text := nullif(p_password_hash, '');
  v_lodging_enabled boolean := coalesce((p_business ->> 'lodging_enabled')::boolean, false);
begin
  if jsonb_typeof(p_business) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Los datos del negocio son inválidos';
  end if;
  if v_name = '' or v_slug = '' or v_whatsapp_number = '' then
    raise exception using errcode = '22023', message = 'Nombre, slug y número son obligatorios';
  end if;
  if (v_client_email is null) <> (v_password_hash is null) then
    raise exception using errcode = '22023', message = 'Email y contraseña deben enviarse juntos';
  end if;
  if v_password_hash is not null and v_password_hash !~ '^\$2[aby]\$[0-9]{2}\$' then
    raise exception using errcode = '22023', message = 'La contraseña debe llegar cifrada';
  end if;
  if p_monthly_rate is not null and p_monthly_rate <= 0 then
    raise exception using errcode = '22023', message = 'La tarifa mensual debe ser mayor que cero';
  end if;

  insert into public.businesses (
    slug, name, type, whatsapp_number, whatsapp_provider,
    ycloud_api_key, ycloud_number,
    ycloud_webhook_endpoint_id, ycloud_webhook_secret,
    meta_token, meta_phone_id, telegram_bot_token,
    takes_bookings, takes_orders, lodging_enabled, ai_provider,
    owner_phone, plan, plan_expires_at,
    active, bot_active, suspended, notes, monthly_rate
  ) values (
    v_slug,
    v_name,
    coalesce(nullif(p_business ->> 'type', ''), 'negocio'),
    v_whatsapp_number,
    coalesce(nullif(p_business ->> 'whatsapp_provider', ''), 'ycloud'),
    nullif(p_business ->> 'ycloud_api_key', ''),
    nullif(p_business ->> 'ycloud_number', ''),
    nullif(btrim(p_business ->> 'ycloud_webhook_endpoint_id'), ''),
    nullif(p_business ->> 'ycloud_webhook_secret', ''),
    nullif(p_business ->> 'meta_token', ''),
    nullif(p_business ->> 'meta_phone_id', ''),
    nullif(p_business ->> 'telegram_bot_token', ''),
    coalesce((p_business ->> 'takes_bookings')::boolean, false),
    coalesce((p_business ->> 'takes_orders')::boolean, true),
    v_lodging_enabled,
    nullif(p_business ->> 'ai_provider', ''),
    nullif(p_business ->> 'owner_phone', ''),
    coalesce(nullif(p_business ->> 'plan', ''), 'basic'),
    nullif(p_business ->> 'plan_expires_at', '')::timestamptz,
    true,
    true,
    false,
    nullif(p_business ->> 'notes', ''),
    p_monthly_rate
  ) returning * into v_business;

  insert into public.bot_policies (business_id) values (v_business.id);

  insert into public.business_schedule (
    business_id, day_of_week, open_time, close_time, slot_duration, is_active
  ) values
    (v_business.id, 0, '09:00', '18:00', 60, false),
    (v_business.id, 1, '09:00', '18:00', 60, true),
    (v_business.id, 2, '09:00', '18:00', 60, true),
    (v_business.id, 3, '09:00', '18:00', 60, true),
    (v_business.id, 4, '09:00', '18:00', 60, true),
    (v_business.id, 5, '09:00', '18:00', 60, true),
    (v_business.id, 6, '09:00', '13:00', 60, true)
  on conflict (business_id, day_of_week) do nothing;

  if v_lodging_enabled then
    insert into public.lodging_settings (business_id)
    values (v_business.id)
    on conflict (business_id) do nothing;
  end if;

  if v_client_email is not null then
    insert into public.client_users (business_id, email, password_hash, role)
    values (v_business.id, v_client_email, v_password_hash, 'owner');
  end if;

  if p_monthly_rate is not null then
    insert into public.billing (business_id, amount, status, period_start, period_end)
    select
      v_business.id,
      p_monthly_rate,
      'pending',
      (date_trunc('month', current_date) + make_interval(months => month_offset))::date,
      (date_trunc('month', current_date) + make_interval(months => month_offset + 1)
        - interval '1 day')::date
    from generate_series(0, 11) as month_offset;
  end if;

  return to_jsonb(v_business);
end;
$$;

alter table public.lodging_settings enable row level security;
alter table public.lodging_room_types enable row level security;
alter table public.lodging_rate_overrides enable row level security;
alter table public.lodging_quotes enable row level security;
alter table public.lodging_requests enable row level security;
alter table public.lodging_blocks enable row level security;

revoke all on table
  public.lodging_settings,
  public.lodging_room_types,
  public.lodging_rate_overrides,
  public.lodging_quotes,
  public.lodging_requests,
  public.lodging_blocks
from public, anon, authenticated;

grant select, insert, update, delete on table
  public.lodging_settings,
  public.lodging_room_types,
  public.lodging_rate_overrides,
  public.lodging_quotes,
  public.lodging_requests
to service_role;

grant select, insert, update on table public.lodging_blocks to service_role;

revoke all on function public.enforce_lodging_block_capacity()
  from public, anon, authenticated;
revoke all on function public.lodging_request_to_json(public.lodging_requests)
  from public, anon, authenticated;
grant execute on function public.lodging_request_to_json(public.lodging_requests)
  to service_role;
revoke all on function public.enforce_lodging_room_type_capacity()
  from public, anon, authenticated;
revoke all on function public.lock_lodging_configuration()
  from public, anon, authenticated;
revoke all on function public.lock_business_lodging_toggle()
  from public, anon, authenticated;

revoke all on function public.expire_lodging_holds(uuid)
  from public, anon, authenticated;
grant execute on function public.expire_lodging_holds(uuid) to service_role;

revoke all on function public.quote_lodging_options(
  uuid, text, text, date, date, integer, integer, integer, text
) from public, anon, authenticated;
grant execute on function public.quote_lodging_options(
  uuid, text, text, date, date, integer, integer, integer, text
) to service_role;

revoke all on function public.create_lodging_request_if_available(
  uuid, uuid, uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_lodging_request_if_available(
  uuid, uuid, uuid, text, text, text, text
) to service_role;

revoke all on function public.set_lodging_request_status(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_lodging_request_status(uuid, uuid, text)
  to service_role;

revoke all on function public.upsert_lodging_block_if_available(
  uuid, uuid, text, date, date, integer, text, uuid
) from public, anon, authenticated;
grant execute on function public.upsert_lodging_block_if_available(
  uuid, uuid, text, date, date, integer, text, uuid
) to service_role;

revoke all on function public.release_lodging_block(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.release_lodging_block(uuid, uuid)
  to service_role;

revoke all on function public.create_business_onboarding(jsonb, text, text, numeric)
  from public, anon, authenticated;
grant execute on function public.create_business_onboarding(jsonb, text, text, numeric)
  to service_role;

commit;

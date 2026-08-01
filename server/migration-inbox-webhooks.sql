-- Inbox durable para webhooks Meta y YCloud.
-- Ejecutar DESPUES de migration-firmas-webhooks.sql y antes de desplegar
-- el runtime que usa enqueue_webhook_event/lease_webhook_events.
--
-- La migracion es aditiva e idempotente. Conserva temporalmente
-- claim_webhook_event para que las replicas antiguas sigan funcionando durante
-- un rolling deploy, pero esos reclamos se guardan como completed y nunca se
-- convierten en trabajos sin payload.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

create table if not exists public.webhook_inbound_events (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  provider        text not null check (provider in ('meta', 'ycloud')),
  message_id_hash text not null check (message_id_hash ~ '^[0-9a-f]{64}$'),
  received_at     timestamptz not null default now()
);

-- Impide que una replica antigua inserte mientras se clasifican las filas
-- historicas. El lock es breve y se libera al hacer commit.
lock table public.webhook_inbound_events in share row exclusive mode;

alter table public.webhook_inbound_events
  add column if not exists payload_version smallint not null default 1,
  add column if not exists payload jsonb,
  add column if not exists stream_key_hash text,
  add column if not exists status text not null default 'completed',
  add column if not exists attempts integer not null default 0,
  add column if not exists max_attempts integer not null default 8,
  add column if not exists available_at timestamptz not null default now(),
  add column if not exists lease_token uuid,
  add column if not exists lease_owner text,
  add column if not exists leased_until timestamptz,
  add column if not exists last_error text,
  add column if not exists completed_at timestamptz,
  add column if not exists dead_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

-- ADD COLUMN aplica el default completed a las filas de la deduplicacion
-- anterior. No existe payload recuperable para reintentarlas de forma segura.
update public.webhook_inbound_events
set completed_at = coalesce(completed_at, received_at),
    updated_at = coalesce(updated_at, received_at)
where status = 'completed'
  and payload is null
  and completed_at is null;

-- Debe permanecer completed hasta retirar claim_webhook_event: asi una replica
-- vieja nunca crea accidentalmente un job pending sin payload.
alter table public.webhook_inbound_events
  alter column status set default 'completed';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.webhook_inbound_events'::regclass
      and conname = 'webhook_inbound_events_status_check'
  ) then
    alter table public.webhook_inbound_events
      add constraint webhook_inbound_events_status_check check (
        status in ('pending', 'processing', 'completed', 'dead')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.webhook_inbound_events'::regclass
      and conname = 'webhook_inbound_events_attempts_check'
  ) then
    alter table public.webhook_inbound_events
      add constraint webhook_inbound_events_attempts_check check (
        attempts between 0 and max_attempts
        and max_attempts between 1 and 100
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.webhook_inbound_events'::regclass
      and conname = 'webhook_inbound_events_payload_check'
  ) then
    alter table public.webhook_inbound_events
      add constraint webhook_inbound_events_payload_check check (
        (
          status = 'completed'
          and payload is null
        )
        or (
          status in ('pending', 'processing', 'dead')
          and payload is not null
          and jsonb_typeof(payload) = 'object'
          and pg_column_size(payload) <= 262144
          and stream_key_hash is not null
          and stream_key_hash ~ '^[0-9a-f]{64}$'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.webhook_inbound_events'::regclass
      and conname = 'webhook_inbound_events_lease_check'
  ) then
    alter table public.webhook_inbound_events
      add constraint webhook_inbound_events_lease_check check (
        (
          status = 'processing'
          and lease_token is not null
          and leased_until is not null
          and nullif(btrim(lease_owner), '') is not null
          and char_length(lease_owner) <= 128
        )
        or (
          status <> 'processing'
          and lease_token is null
          and leased_until is null
          and lease_owner is null
        )
      );
  end if;
end;
$$;

create unique index if not exists uq_webhook_events_business_provider_hash
  on public.webhook_inbound_events(business_id, provider, message_id_hash);

create index if not exists idx_webhook_inbox_ready
  on public.webhook_inbound_events(available_at, received_at, id)
  where status = 'pending';

create index if not exists idx_webhook_inbox_expired_leases
  on public.webhook_inbound_events(leased_until)
  where status = 'processing';

create index if not exists idx_webhook_inbox_stream_order
  on public.webhook_inbound_events(
    business_id, provider, stream_key_hash, received_at, id
  )
  where status in ('pending', 'processing');

-- Ultima barrera contra dos respuestas concurrentes al mismo contacto.
create unique index if not exists uq_webhook_inbox_processing_stream
  on public.webhook_inbound_events(business_id, provider, stream_key_hash)
  where status = 'processing';

alter table public.webhook_inbound_events enable row level security;
revoke all on table public.webhook_inbound_events
  from public, anon, authenticated;
grant select, insert, update, delete on table public.webhook_inbound_events
  to service_role;

-- Persiste un evento normalizado. El cuerpo crudo y las credenciales nunca se
-- guardan; el runtime envia hashes SHA-256 y un payload minimo versionado.
create or replace function public.enqueue_webhook_event(
  p_business_id uuid,
  p_provider text,
  p_message_id_hash text,
  p_stream_key_hash text,
  p_payload jsonb
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_inserted integer;
begin
  if p_business_id is null then
    raise exception using errcode = '22023', message = 'El negocio es obligatorio';
  end if;
  if p_provider not in ('meta', 'ycloud') then
    raise exception using errcode = '22023', message = 'Proveedor de webhook invalido';
  end if;
  if p_message_id_hash is null
     or p_message_id_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Hash de mensaje invalido';
  end if;
  if p_stream_key_hash is null
     or p_stream_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Hash de conversacion invalido';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object'
     or pg_column_size(p_payload) > 262144 then
    raise exception using errcode = '22023', message = 'Payload de webhook invalido';
  end if;

  insert into public.webhook_inbound_events (
    business_id,
    provider,
    message_id_hash,
    stream_key_hash,
    payload_version,
    payload,
    status,
    attempts,
    max_attempts,
    available_at,
    completed_at,
    dead_at,
    updated_at
  ) values (
    p_business_id,
    p_provider,
    p_message_id_hash,
    p_stream_key_hash,
    1,
    p_payload,
    'pending',
    0,
    8,
    now(),
    null,
    null,
    now()
  )
  on conflict (business_id, provider, message_id_hash) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end;
$$;

-- Reclama trabajo listo con lease. Los leases vencidos se recuperan antes de
-- elegir candidatos; el fencing token impide ACKs de un worker anterior.
create or replace function public.lease_webhook_events(
  p_worker_id text,
  p_limit integer,
  p_lease_seconds integer
)
returns table (
  id uuid,
  business_id uuid,
  provider text,
  payload jsonb,
  lease_token uuid,
  attempts integer
)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 50));
  v_lease_seconds integer := greatest(
    30, least(coalesce(p_lease_seconds, 180), 900)
  );
begin
  if nullif(btrim(p_worker_id), '') is null
     or char_length(p_worker_id) > 128 then
    raise exception using errcode = '22023', message = 'Worker ID invalido';
  end if;

  -- Un ultimo intento cuyo proceso murio no debe quedar processing para siempre.
  update public.webhook_inbound_events as event
  set status = 'dead',
      lease_token = null,
      lease_owner = null,
      leased_until = null,
      dead_at = now(),
      last_error = coalesce(
        event.last_error,
        'Lease vencido despues del ultimo intento'
      ),
      updated_at = now()
  where event.status = 'processing'
    and event.leased_until <= now()
    and event.attempts >= event.max_attempts;

  -- Los demas leases vencidos vuelven a estar disponibles y el siguiente
  -- reclamo incrementa attempts con un token nuevo.
  update public.webhook_inbound_events as event
  set status = 'pending',
      available_at = least(event.available_at, now()),
      lease_token = null,
      lease_owner = null,
      leased_until = null,
      updated_at = now()
  where event.status = 'processing'
    and event.leased_until <= now()
    and event.attempts < event.max_attempts;

  return query
  with candidates as (
    select event.id
    from public.webhook_inbound_events as event
    where event.status = 'pending'
      and event.available_at <= now()
      and event.attempts < event.max_attempts
      -- FIFO por conversacion: una demora/reintento anterior bloquea solamente
      -- su mismo stream, no a otros negocios o contactos.
      and not exists (
        select 1
        from public.webhook_inbound_events as earlier
        where earlier.business_id = event.business_id
          and earlier.provider = event.provider
          and earlier.stream_key_hash = event.stream_key_hash
          and earlier.status in ('pending', 'processing')
          and (earlier.received_at, earlier.id) < (event.received_at, event.id)
      )
    order by event.received_at, event.id
    for update of event skip locked
    limit v_limit
  ), leased_rows as (
    update public.webhook_inbound_events as event
    set status = 'processing',
        attempts = event.attempts + 1,
        lease_token = gen_random_uuid(),
        lease_owner = btrim(p_worker_id),
        leased_until = now() + make_interval(secs => v_lease_seconds),
        updated_at = now()
    from candidates
    where event.id = candidates.id
    returning
      event.id as leased_id,
      event.business_id as leased_business_id,
      event.provider as leased_provider,
      event.payload as leased_payload,
      event.lease_token as leased_token,
      event.attempts as leased_attempts
  )
  select
    leased_rows.leased_id,
    leased_rows.leased_business_id,
    leased_rows.leased_provider,
    leased_rows.leased_payload,
    leased_rows.leased_token,
    leased_rows.leased_attempts
  from leased_rows;
end;
$$;

create or replace function public.renew_webhook_event_lease(
  p_event_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_renewed integer;
  v_lease_seconds integer := greatest(
    30, least(coalesce(p_lease_seconds, 180), 900)
  );
begin
  if p_event_id is null or p_lease_token is null then return false; end if;

  update public.webhook_inbound_events as event
  set leased_until = now() + make_interval(secs => v_lease_seconds),
      updated_at = now()
  where event.id = p_event_id
    and event.status = 'processing'
    and event.lease_token = p_lease_token
    and event.leased_until > now();

  get diagnostics v_renewed = row_count;
  return v_renewed = 1;
end;
$$;

create or replace function public.complete_webhook_event(
  p_event_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_completed integer;
begin
  if p_event_id is null or p_lease_token is null then return false; end if;

  update public.webhook_inbound_events as event
  set status = 'completed',
      payload = null,
      lease_token = null,
      lease_owner = null,
      leased_until = null,
      last_error = null,
      completed_at = now(),
      dead_at = null,
      updated_at = now()
  where event.id = p_event_id
    and event.status = 'processing'
    and event.lease_token = p_lease_token;

  get diagnostics v_completed = row_count;
  return v_completed = 1;
end;
$$;

create or replace function public.fail_webhook_event(
  p_event_id uuid,
  p_lease_token uuid,
  p_error text,
  p_base_delay_seconds integer
)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_attempts integer;
  v_max_attempts integer;
  v_base_delay integer := greatest(
    1, least(coalesce(p_base_delay_seconds, 5), 300)
  );
  v_delay_seconds integer;
  v_error text := left(
    coalesce(nullif(btrim(p_error), ''), 'Error de procesamiento'),
    2000
  );
begin
  if p_event_id is null or p_lease_token is null then return 'stale'; end if;

  select event.attempts, event.max_attempts
  into v_attempts, v_max_attempts
  from public.webhook_inbound_events as event
  where event.id = p_event_id
    and event.status = 'processing'
    and event.lease_token = p_lease_token
  for update;

  if not found then return 'stale'; end if;

  if v_attempts >= v_max_attempts then
    update public.webhook_inbound_events as event
    set status = 'dead',
        lease_token = null,
        lease_owner = null,
        leased_until = null,
        last_error = v_error,
        dead_at = now(),
        updated_at = now()
    where event.id = p_event_id
      and event.status = 'processing'
      and event.lease_token = p_lease_token;
    return 'dead';
  end if;

  -- 5s, 10s, 20s... con base configurable, jitter y tope de 15 min.
  v_delay_seconds := least(
    900,
    v_base_delay
      * power(2::numeric, least(greatest(v_attempts - 1, 0), 10))::integer
      + floor(random() * least(v_base_delay, 30))::integer
  );

  update public.webhook_inbound_events as event
  set status = 'pending',
      available_at = now() + make_interval(secs => v_delay_seconds),
      lease_token = null,
      lease_owner = null,
      leased_until = null,
      last_error = v_error,
      dead_at = null,
      updated_at = now()
  where event.id = p_event_id
    and event.status = 'processing'
    and event.lease_token = p_lease_token;

  return 'pending';
end;
$$;

create or replace function public.cleanup_webhook_events()
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  with deleted as (
    delete from public.webhook_inbound_events as event
    where (
      event.status = 'completed'
      and coalesce(event.completed_at, event.received_at)
        < now() - interval '24 hours'
    ) or (
      event.status = 'dead'
      and coalesce(event.dead_at, event.updated_at, event.received_at)
        < now() - interval '7 days'
    )
    returning 1
  )
  select count(*)::integer into v_deleted from deleted;

  return v_deleted;
end;
$$;

-- Compatibilidad temporal con el runtime anterior. Solo deduplica y clasifica
-- su fila como terminal; no puede producir trabajo que el worker intente leer.
create or replace function public.claim_webhook_event(
  p_business_id uuid,
  p_provider text,
  p_message_id_hash text
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_inserted integer;
begin
  if p_business_id is null then
    raise exception using errcode = '22023', message = 'El negocio es obligatorio';
  end if;
  if p_provider not in ('meta', 'ycloud') then
    raise exception using errcode = '22023', message = 'Proveedor de webhook invalido';
  end if;
  if p_message_id_hash is null
     or p_message_id_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Hash de mensaje invalido';
  end if;

  delete from public.webhook_inbound_events
  where business_id = p_business_id
    and status = 'completed'
    and coalesce(completed_at, received_at) < now() - interval '24 hours';

  insert into public.webhook_inbound_events (
    business_id,
    provider,
    message_id_hash,
    status,
    completed_at,
    updated_at
  ) values (
    p_business_id,
    p_provider,
    p_message_id_hash,
    'completed',
    now(),
    now()
  )
  on conflict (business_id, provider, message_id_hash) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end;
$$;

revoke all on function public.enqueue_webhook_event(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.lease_webhook_events(text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.renew_webhook_event_lease(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.complete_webhook_event(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.fail_webhook_event(uuid, uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.cleanup_webhook_events()
  from public, anon, authenticated;
revoke all on function public.claim_webhook_event(uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.enqueue_webhook_event(uuid, text, text, text, jsonb)
  to service_role;
grant execute on function public.lease_webhook_events(text, integer, integer)
  to service_role;
grant execute on function public.renew_webhook_event_lease(uuid, uuid, integer)
  to service_role;
grant execute on function public.complete_webhook_event(uuid, uuid)
  to service_role;
grant execute on function public.fail_webhook_event(uuid, uuid, text, integer)
  to service_role;
grant execute on function public.cleanup_webhook_events()
  to service_role;
grant execute on function public.claim_webhook_event(uuid, text, text)
  to service_role;

commit;

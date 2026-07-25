-- Agrupado durable de mensajes de texto consecutivos del inbox de webhooks.
-- Ejecutar DESPUES de migration-inbox-webhooks.sql y antes de desplegar el
-- runtime que evita el debounce en memoria cuando recibe _inboxBatch.
--
-- Conserva las firmas y columnas de las RPC existentes para permitir rolling
-- deploys. El lote se congela dentro del payload de la cabeza:
--   "_inboxBatch": { "version": 1, "eventIds": ["cabeza", "..."] }
-- complete_webhook_event usa ese snapshot bajo el mismo fencing token.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

-- Un texto nuevo abre (o extiende) una ventana de silencio de tres segundos
-- para el sufijo textual pendiente del stream. Un duplicado no extiende la
-- ventana porque ON CONFLICT no inserta ninguna fila.
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
  v_event_id uuid;
  v_received_at timestamptz;
  v_quiet_until timestamptz;
  v_is_text boolean;
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
     or pg_column_size(p_payload) > 262144
     or p_payload ? '_inboxBatch' then
    raise exception using errcode = '22023', message = 'Payload de webhook invalido';
  end if;

  v_is_text := coalesce((
    p_payload #>> '{content,kind}' = 'text'
    and jsonb_typeof(p_payload #> '{content,text}') = 'string'
  ), false);
  -- Serializa solamente los enqueue del mismo stream. Así dos textos
  -- concurrentes observan la ventana más reciente y un duplicado nunca la
  -- prolonga. Una colisión del hash solo reduce concurrencia, no mezcla datos.
  perform pg_advisory_xact_lock(hashtextextended(
    p_business_id::text || ':' || p_provider || ':' || p_stream_key_hash,
    0
  ));
  v_received_at := clock_timestamp();
  v_quiet_until := v_received_at + interval '3 seconds';

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
    received_at,
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
    case when v_is_text then v_quiet_until else now() end,
    null,
    null,
    v_received_at,
    v_received_at
  )
  on conflict (business_id, provider, message_id_hash) do nothing
  returning id into v_event_id;

  if not found then
    return false;
  end if;

  if v_is_text then
    update public.webhook_inbound_events as queued
    set available_at = greatest(queued.available_at, v_quiet_until),
        updated_at = clock_timestamp()
    where queued.business_id = p_business_id
      and queued.provider = p_provider
      and queued.stream_key_hash = p_stream_key_hash
      and queued.status = 'pending'
      and queued.payload #>> '{content,kind}' = 'text'
      and jsonb_typeof(queued.payload #> '{content,text}') = 'string'
      and not (queued.payload ? '_inboxBatch')
      and (queued.received_at, queued.id) <= (v_received_at, v_event_id)
      -- Una imagen/audio (o un lote ya congelado) separa conversaciones
      -- textuales aunque haya más textos pendientes después de esa frontera.
      and not exists (
        select 1
        from public.webhook_inbound_events as boundary
        where boundary.business_id = queued.business_id
          and boundary.provider = queued.provider
          and boundary.stream_key_hash = queued.stream_key_hash
          and boundary.status in ('pending', 'processing')
          and (boundary.received_at, boundary.id)
            > (queued.received_at, queued.id)
          and (boundary.received_at, boundary.id)
            < (v_received_at, v_event_id)
          and (
            boundary.payload #>> '{content,kind}' is distinct from 'text'
            or boundary.payload ? '_inboxBatch'
          )
      );
  end if;

  return true;
end;
$$;

-- Reclama una cabeza por stream y, si es texto, congela hasta 20 textos
-- consecutivos cuyo contenido combinado (incluidos los saltos de línea) no
-- excede 16.384 caracteres. La firma/retorno permanece idéntica.
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
  v_head record;
  v_batch_ids uuid[];
  v_combined_text text;
  v_latest_inbound_id text;
  v_payload jsonb;
  v_lease_token uuid;
  v_attempts integer;
  v_frozen boolean;
  v_terminal_head record;
  v_terminal_ids uuid[];
  v_terminal_locked_ids uuid[];
  v_terminal_member record;
  v_terminal_distinct integer;
  v_terminal_updated integer;
  v_has_terminal_snapshot boolean;
begin
  if nullif(btrim(p_worker_id), '') is null
     or char_length(p_worker_id) > 128 then
    raise exception using errcode = '22023', message = 'Worker ID invalido';
  end if;

  -- Si venció el último lease, toda la foto congelada va a dead-letter.
  -- Dejar sus miembros pending permitiría que se procesen otra vez después de
  -- que la cabeza ya pudo haber enviado una respuesta antes de morir.
  for v_terminal_head in
    select event.*
    from public.webhook_inbound_events as event
    where event.status = 'processing'
      and event.leased_until <= now()
      and event.attempts >= event.max_attempts
    order by event.received_at, event.id
    for update of event skip locked
    limit 100
  loop
    v_terminal_ids := array[v_terminal_head.id];
    v_has_terminal_snapshot := false;

    if (v_terminal_head.payload #>> '{_inboxBatch,version}') = '1'
       and jsonb_typeof(
         v_terminal_head.payload #> '{_inboxBatch,eventIds}'
       ) = 'array' then
      if jsonb_array_length(
        v_terminal_head.payload #> '{_inboxBatch,eventIds}'
      ) between 1 and 20
         and not exists (
           select 1
           from jsonb_array_elements(
             v_terminal_head.payload #> '{_inboxBatch,eventIds}'
           ) as item(value)
           where jsonb_typeof(item.value) is distinct from 'string'
              or (item.value #>> '{}') !~
                '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         ) then
        select array_agg(
          (item.value #>> '{}')::uuid
          order by item.ordinality
        )
        into v_terminal_ids
        from jsonb_array_elements(
          v_terminal_head.payload #> '{_inboxBatch,eventIds}'
        ) with ordinality as item(value, ordinality);

        select count(distinct member.id)::integer
        into v_terminal_distinct
        from unnest(v_terminal_ids) as member(id);

        v_has_terminal_snapshot :=
          v_terminal_ids[1] = v_terminal_head.id
          and v_terminal_distinct = cardinality(v_terminal_ids);
      end if;
    end if;

    if v_has_terminal_snapshot then
      v_terminal_locked_ids := array[]::uuid[];
      for v_terminal_member in
        select event.*
        from public.webhook_inbound_events as event
        where event.id = any(v_terminal_ids)
        order by event.received_at, event.id
        for update
      loop
        if v_terminal_member.business_id is distinct from v_terminal_head.business_id
           or v_terminal_member.provider is distinct from v_terminal_head.provider
           or v_terminal_member.stream_key_hash
             is distinct from v_terminal_head.stream_key_hash
           or v_terminal_member.payload #>> '{content,kind}'
             is distinct from 'text'
           or (
             v_terminal_member.id = v_terminal_head.id
             and (
               v_terminal_member.status is distinct from 'processing'
               or v_terminal_member.lease_token
                 is distinct from v_terminal_head.lease_token
             )
           )
           or (
             v_terminal_member.id <> v_terminal_head.id
             and (
               v_terminal_member.status is distinct from 'pending'
               or v_terminal_member.lease_token is not null
             )
           ) then
          raise exception using
            errcode = '40001',
            message = 'El lote expirado del webhook cambió antes de dead-letter';
        end if;
        v_terminal_locked_ids := array_append(
          v_terminal_locked_ids,
          v_terminal_member.id
        );
      end loop;

      if v_terminal_locked_ids is distinct from v_terminal_ids then
        raise exception using
          errcode = '40001',
          message = 'El lote expirado del webhook está incompleto';
      end if;
    else
      v_terminal_ids := array[v_terminal_head.id];
    end if;

    update public.webhook_inbound_events as event
    set status = 'dead',
        lease_token = null,
        lease_owner = null,
        leased_until = null,
        last_error = coalesce(
          event.last_error,
          'Lease vencido despues del ultimo intento'
        ),
        completed_at = null,
        dead_at = now(),
        updated_at = now()
    where event.id = any(v_terminal_ids)
      and event.business_id = v_terminal_head.business_id
      and event.provider = v_terminal_head.provider
      and event.stream_key_hash = v_terminal_head.stream_key_hash
      and (
        (
          event.id = v_terminal_head.id
          and event.status = 'processing'
          and event.lease_token = v_terminal_head.lease_token
        )
        or (
          event.id <> v_terminal_head.id
          and event.status = 'pending'
          and event.lease_token is null
        )
      );

    get diagnostics v_terminal_updated = row_count;
    if v_terminal_updated <> cardinality(v_terminal_ids) then
      raise exception using
        errcode = '40001',
        message = 'El lote expirado cambió durante su terminalización';
    end if;
  end loop;

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

  for v_head in
    select event.*
    from public.webhook_inbound_events as event
    where event.status = 'pending'
      and event.available_at <= now()
      and event.attempts < event.max_attempts
      and not exists (
        select 1
        from public.webhook_inbound_events as earlier
        where earlier.business_id = event.business_id
          and earlier.provider = event.provider
          and earlier.stream_key_hash = event.stream_key_hash
          and earlier.status in ('pending', 'processing')
          and (earlier.received_at, earlier.id)
            < (event.received_at, event.id)
      )
    order by event.received_at, event.id
    for update of event skip locked
    limit v_limit
  loop
    v_payload := v_head.payload;
    v_batch_ids := null;
    v_combined_text := null;
    v_latest_inbound_id := null;
    v_frozen := case
      when (v_head.payload #>> '{_inboxBatch,version}') = '1'
       and jsonb_typeof(
         v_head.payload #> '{_inboxBatch,eventIds}'
       ) = 'array'
      then jsonb_array_length(
        v_head.payload #> '{_inboxBatch,eventIds}'
      ) between 1 and 20
        and (v_head.payload #>> '{_inboxBatch,eventIds,0}') = v_head.id::text
      else false
    end;

    -- Un retry conserva exactamente el snapshot anterior. Los mensajes que
    -- llegaron después quedan pendientes para el siguiente lote.
    if not v_frozen
       and v_head.payload #>> '{content,kind}' = 'text'
       and jsonb_typeof(v_head.payload #> '{content,text}') = 'string' then
      with eligible as (
        select
          member.id,
          member.payload,
          member.received_at,
          row_number() over (
            order by member.received_at, member.id
          ) as batch_position,
          sum(
            char_length(member.payload #>> '{content,text}')
            + case when member.id = v_head.id then 0 else 1 end
          ) over (
            order by member.received_at, member.id
            rows between unbounded preceding and current row
          ) as combined_length
        from public.webhook_inbound_events as member
        where member.business_id = v_head.business_id
          and member.provider = v_head.provider
          and member.stream_key_hash = v_head.stream_key_hash
          and member.status = 'pending'
          and member.available_at <= now()
          and member.attempts < member.max_attempts
          and member.payload #>> '{content,kind}' = 'text'
          and jsonb_typeof(member.payload #> '{content,text}') = 'string'
          and not (member.payload ? '_inboxBatch')
          and (member.received_at, member.id)
            >= (v_head.received_at, v_head.id)
          -- No salta una frontera no textual, un retry congelado ni una fila
          -- todavía no disponible: solo toma un prefijo consecutivo.
          and not exists (
            select 1
            from public.webhook_inbound_events as boundary
            where boundary.business_id = v_head.business_id
              and boundary.provider = v_head.provider
              and boundary.stream_key_hash = v_head.stream_key_hash
              and boundary.status in ('pending', 'processing')
              and (boundary.received_at, boundary.id)
                >= (v_head.received_at, v_head.id)
              and (boundary.received_at, boundary.id)
                < (member.received_at, member.id)
              and (
                boundary.payload #>> '{content,kind}' is distinct from 'text'
                or jsonb_typeof(boundary.payload #> '{content,text}')
                  is distinct from 'string'
                or boundary.payload ? '_inboxBatch'
                or boundary.available_at > now()
                or boundary.attempts >= boundary.max_attempts
              )
          )
      ), bounded as (
        select *
        from eligible
        where batch_position <= 20
          and combined_length <= 16384
      )
      select
        array_agg(bounded.id order by bounded.received_at, bounded.id),
        string_agg(
          bounded.payload #>> '{content,text}',
          E'\n'
          order by bounded.received_at, bounded.id
        ),
        (
          array_agg(
            bounded.payload ->> 'inboundId'
            order by bounded.received_at desc, bounded.id desc
          )
        )[1]
      into v_batch_ids, v_combined_text, v_latest_inbound_id
      from bounded;

      -- Los payloads normalizados válidos siempre incluyen la cabeza. Este
      -- fallback conserva el fallo/retry de una fila histórica malformada sin
      -- permitir que se apropie de otros IDs.
      if v_batch_ids is null
         or v_batch_ids[1] is distinct from v_head.id then
        v_batch_ids := array[v_head.id];
        v_combined_text := v_head.payload #>> '{content,text}';
        v_latest_inbound_id := v_head.payload ->> 'inboundId';
      end if;

      v_payload := jsonb_set(
        jsonb_set(
          v_head.payload - '_inboxBatch',
          '{content,text}',
          to_jsonb(v_combined_text),
          false
        ),
        '{inboundId}',
        to_jsonb(v_latest_inbound_id),
        false
      ) || jsonb_build_object(
        '_inboxBatch',
        jsonb_build_object(
          'version', 1,
          'eventIds', to_jsonb(v_batch_ids)
        )
      );
    elsif not v_frozen then
      -- _inboxBatch es un namespace interno reservado; nunca se confía en
      -- metadata presente en un payload histórico no textual.
      v_payload := v_head.payload - '_inboxBatch';
    end if;

    update public.webhook_inbound_events as event
    set status = 'processing',
        attempts = event.attempts + 1,
        payload = v_payload,
        lease_token = gen_random_uuid(),
        lease_owner = btrim(p_worker_id),
        leased_until = now() + make_interval(secs => v_lease_seconds),
        updated_at = now()
    where event.id = v_head.id
      and event.status = 'pending'
    returning event.lease_token, event.attempts
      into v_lease_token, v_attempts;

    if found then
      id := v_head.id;
      business_id := v_head.business_id;
      provider := v_head.provider;
      payload := v_payload;
      lease_token := v_lease_token;
      attempts := v_attempts;
      return next;
    end if;
  end loop;
end;
$$;

-- Completa la cabeza y todos los IDs del snapshot en una sola transacción.
-- La cabeza debe conservar el fencing token; los miembros continúan pending y
-- en el mismo stream hasta este ACK. Un payload sin metadata (lease antiguo
-- que ya estaba en vuelo durante la migración) conserva el ACK unitario.
create or replace function public.complete_webhook_event(
  p_event_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_head record;
  v_batch jsonb;
  v_batch_ids uuid[];
  v_locked_ids uuid[] := array[]::uuid[];
  v_member record;
  v_distinct_count integer;
  v_completed integer;
begin
  if p_event_id is null or p_lease_token is null then return false; end if;

  select event.*
  into v_head
  from public.webhook_inbound_events as event
  where event.id = p_event_id
    and event.status = 'processing'
    and event.lease_token = p_lease_token
  for update;

  if not found then return false; end if;

  v_batch := v_head.payload -> '_inboxBatch';
  if v_batch is null then
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
  end if;

  if jsonb_typeof(v_batch) is distinct from 'object'
     or (v_batch ->> 'version') is distinct from '1'
     or jsonb_typeof(v_batch -> 'eventIds') is distinct from 'array' then
    return false;
  end if;

  if jsonb_array_length(v_batch -> 'eventIds') not between 1 and 20 then
    return false;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_batch -> 'eventIds') as item(value)
    where jsonb_typeof(item.value) is distinct from 'string'
       or (item.value #>> '{}') !~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) then
    return false;
  end if;

  select array_agg(
    (item.value #>> '{}')::uuid
    order by item.ordinality
  )
  into v_batch_ids
  from jsonb_array_elements(v_batch -> 'eventIds')
    with ordinality as item(value, ordinality);

  if v_batch_ids[1] is distinct from p_event_id then return false; end if;

  select count(distinct member.id)::integer
  into v_distinct_count
  from unnest(v_batch_ids) as member(id);
  if v_distinct_count <> cardinality(v_batch_ids) then return false; end if;

  -- Bloquea todos los miembros antes de validar o mutar. La comparación del
  -- orden impide completar IDs ajenos o saltar una frontera FIFO.
  for v_member in
    select event.*
    from public.webhook_inbound_events as event
    where event.id = any(v_batch_ids)
    order by event.received_at, event.id
    for update
  loop
    if v_member.business_id is distinct from v_head.business_id
       or v_member.provider is distinct from v_head.provider
       or v_member.stream_key_hash is distinct from v_head.stream_key_hash
       or v_member.payload #>> '{content,kind}' is distinct from 'text'
       or (
         v_member.id = p_event_id
         and (
           v_member.status is distinct from 'processing'
           or v_member.lease_token is distinct from p_lease_token
         )
       )
       or (
         v_member.id <> p_event_id
         and (
           v_member.status is distinct from 'pending'
           or v_member.lease_token is not null
         )
       ) then
      return false;
    end if;

    v_locked_ids := array_append(v_locked_ids, v_member.id);
  end loop;

  if v_locked_ids is distinct from v_batch_ids then return false; end if;

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
  where event.id = any(v_batch_ids)
    and event.business_id = v_head.business_id
    and event.provider = v_head.provider
    and event.stream_key_hash = v_head.stream_key_hash
    and (
      (
        event.id = p_event_id
        and event.status = 'processing'
        and event.lease_token = p_lease_token
      )
      or (
        event.id <> p_event_id
        and event.status = 'pending'
        and event.lease_token is null
      )
    );

  get diagnostics v_completed = row_count;
  if v_completed <> cardinality(v_batch_ids) then
    raise exception using
      errcode = '40001',
      message = 'El lote del webhook cambió durante su finalización';
  end if;

  return true;
end;
$$;

-- Los retries normales liberan solo la cabeza y conservan los miembros del
-- snapshot pendientes. Al agotar intentos, todo el lote pasa a dead-letter en
-- la misma transacción para que ningún miembro se procese por separado.
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
  v_head record;
  v_base_delay integer := greatest(
    1, least(coalesce(p_base_delay_seconds, 5), 300)
  );
  v_delay_seconds integer;
  v_error text := left(
    coalesce(nullif(btrim(p_error), ''), 'Error de procesamiento'),
    2000
  );
  v_batch_ids uuid[];
  v_locked_ids uuid[];
  v_member record;
  v_distinct_count integer;
  v_updated integer;
  v_has_snapshot boolean;
begin
  if p_event_id is null or p_lease_token is null then return 'stale'; end if;

  select event.*
  into v_head
  from public.webhook_inbound_events as event
  where event.id = p_event_id
    and event.status = 'processing'
    and event.lease_token = p_lease_token
  for update;

  if not found then return 'stale'; end if;

  if v_head.attempts >= v_head.max_attempts then
    v_batch_ids := array[v_head.id];
    v_has_snapshot := false;

    if (v_head.payload #>> '{_inboxBatch,version}') = '1'
       and jsonb_typeof(
         v_head.payload #> '{_inboxBatch,eventIds}'
       ) = 'array' then
      if jsonb_array_length(
        v_head.payload #> '{_inboxBatch,eventIds}'
      ) between 1 and 20
         and not exists (
           select 1
           from jsonb_array_elements(
             v_head.payload #> '{_inboxBatch,eventIds}'
           ) as item(value)
           where jsonb_typeof(item.value) is distinct from 'string'
              or (item.value #>> '{}') !~
                '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         ) then
        select array_agg(
          (item.value #>> '{}')::uuid
          order by item.ordinality
        )
        into v_batch_ids
        from jsonb_array_elements(
          v_head.payload #> '{_inboxBatch,eventIds}'
        ) with ordinality as item(value, ordinality);

        select count(distinct member.id)::integer
        into v_distinct_count
        from unnest(v_batch_ids) as member(id);

        v_has_snapshot := v_batch_ids[1] = v_head.id
          and v_distinct_count = cardinality(v_batch_ids);
      end if;
    end if;

    if v_has_snapshot then
      v_locked_ids := array[]::uuid[];
      for v_member in
        select event.*
        from public.webhook_inbound_events as event
        where event.id = any(v_batch_ids)
        order by event.received_at, event.id
        for update
      loop
        if v_member.business_id is distinct from v_head.business_id
           or v_member.provider is distinct from v_head.provider
           or v_member.stream_key_hash is distinct from v_head.stream_key_hash
           or v_member.payload #>> '{content,kind}' is distinct from 'text'
           or (
             v_member.id = p_event_id
             and (
               v_member.status is distinct from 'processing'
               or v_member.lease_token is distinct from p_lease_token
             )
           )
           or (
             v_member.id <> p_event_id
             and (
               v_member.status is distinct from 'pending'
               or v_member.lease_token is not null
             )
           ) then
          raise exception using
            errcode = '40001',
            message = 'El lote fallido del webhook cambió antes de dead-letter';
        end if;
        v_locked_ids := array_append(v_locked_ids, v_member.id);
      end loop;

      if v_locked_ids is distinct from v_batch_ids then
        raise exception using
          errcode = '40001',
          message = 'El lote fallido del webhook está incompleto';
      end if;
    else
      v_batch_ids := array[v_head.id];
    end if;

    update public.webhook_inbound_events as event
    set status = 'dead',
        lease_token = null,
        lease_owner = null,
        leased_until = null,
        last_error = v_error,
        completed_at = null,
        dead_at = now(),
        updated_at = now()
    where event.id = any(v_batch_ids)
      and event.business_id = v_head.business_id
      and event.provider = v_head.provider
      and event.stream_key_hash = v_head.stream_key_hash
      and (
        (
          event.id = p_event_id
          and event.status = 'processing'
          and event.lease_token = p_lease_token
        )
        or (
          event.id <> p_event_id
          and event.status = 'pending'
          and event.lease_token is null
        )
      );

    get diagnostics v_updated = row_count;
    if v_updated <> cardinality(v_batch_ids) then
      raise exception using
        errcode = '40001',
        message = 'El lote fallido cambió durante su terminalización';
    end if;
    return 'dead';
  end if;

  -- 5s, 10s, 20s... con base configurable, jitter y tope de 15 min.
  v_delay_seconds := least(
    900,
    v_base_delay
      * power(
        2::numeric,
        least(greatest(v_head.attempts - 1, 0), 10)
      )::integer
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

revoke all on function public.enqueue_webhook_event(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.lease_webhook_events(text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.complete_webhook_event(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.fail_webhook_event(uuid, uuid, text, integer)
  from public, anon, authenticated;

grant execute on function public.enqueue_webhook_event(uuid, text, text, text, jsonb)
  to service_role;
grant execute on function public.lease_webhook_events(text, integer, integer)
  to service_role;
grant execute on function public.complete_webhook_event(uuid, uuid)
  to service_role;
grant execute on function public.fail_webhook_event(uuid, uuid, text, integer)
  to service_role;

commit;

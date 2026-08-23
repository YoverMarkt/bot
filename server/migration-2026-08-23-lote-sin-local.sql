-- ============================================================
-- El lote de un mensaje SIN local nunca podía cerrarse
-- ============================================================
--
-- ⚠️ LA CAUSA RAÍZ de que el marketplace se quedara mudo, encontrada el
-- 2026-08-23 llamando a la función con el token real del evento atascado:
-- no se colgaba, LANZABA —en 191 ms— «El lote del webhook cambió durante su
-- finalización».
--
-- El porqué es el mismo fallo del NULL que este proyecto ya ha visto tres
-- veces, ahora en el `update` final de las dos funciones:
--
--     and event.business_id = v_head.business_id
--
-- En un mensaje al número de la plataforma `business_id` es NULL en los dos
-- lados, y **`NULL = NULL` no es verdadero: es NULL**. Así que el `where` no
-- casaba ninguna fila, `row_count` daba 0 en vez de 1, y la función lanzaba.
--
-- Consecuencia: un evento del marketplace con lote **no podía completarse NI
-- marcarse fallido**. Se quedaba reservado hasta que venciera el lease, se
-- reintentaba —reprocesando, así que el cliente recibía la misma respuesta
-- cada tres minutos— y a los ocho intentos moría. Y como la cola es FIFO por
-- conversación, todos sus mensajes siguientes esperaban detrás: por eso
-- elegir un local nunca llegaba a entregar el enlace de la mini app.
--
-- ⚠️ La migración del canal de plataforma arregló exactamente esto en el FIFO
-- de `lease_webhook_events` (`is not distinct from`), en los índices únicos
-- parciales y en el disparador de consumo. **Estos dos `update` se quedaron
-- atrás.** El bucle que valida los miembros, unas líneas más arriba, sí usaba
-- `is distinct from` — lo que hacía el fallo aún más difícil de ver.
--
-- ⚠️ Las dos funciones se copian de la versión VIVA de `schema.sql` y se les
-- cambia SOLO ese predicado, con asserts que lo comprueban. Copiarlas de su
-- migración original las revertiría a una versión anterior en silencio.
--
-- ⚠️ Para los negocios CON número propio no cambia nada: `is not distinct
-- from` se comporta igual que `=` cuando ningún lado es nulo.

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
    and event.business_id is not distinct from v_head.business_id
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
      and event.business_id is not distinct from v_head.business_id
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

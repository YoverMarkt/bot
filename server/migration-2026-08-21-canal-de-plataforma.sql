-- ============================================================
-- El mensaje que llega al número de la plataforma todavía no tiene local
-- ============================================================
--
-- Hasta hoy, TODO evento entrante pertenecía a un negocio: el número al que
-- llegaba el mensaje era la llave de enrutado y `getBusinessByChannel` lo
-- resolvía antes de encolar nada. Con un número único para todo el
-- marketplace (2026-08-20) eso deja de ser cierto en el primer mensaje: el
-- cliente escribe «hola» a Umbani y todavía no ha elegido local.
--
-- La cola durable lo impedía en tres sitios, y solo el primero es evidente:
--
--   1. `webhook_inbound_events.business_id not null`.
--   2. `enqueue_webhook_event` aborta con «El negocio es obligatorio».
--   3. ⚠️ El menos visible y el más grave: los dos índices ÚNICOS que
--      protegen la cola empiezan por `business_id`, y en SQL dos NULL no
--      son iguales. Un índice único sobre `(business_id, provider,
--      message_id_hash)` NO deduplica nada cuando el negocio es nulo: la
--      entrada es *at-least-once*, así que el mismo mensaje reentregado se
--      habría procesado —y contestado— dos veces.
--
-- Por eso los índices de aquí abajo son PARCIALES sobre `business_id is
-- null`: los eventos CON negocio siguen usando exactamente los índices de
-- siempre y su comportamiento no cambia en nada.

-- ── 1. La columna admite «todavía no hay local» ──────────────────────
--
-- La foránea a `businesses` se conserva tal cual: cuando el cliente elige
-- local, los mensajes siguientes sí lo llevan, y ahí `on delete cascade`
-- tiene que seguir limpiando igual.
alter table public.webhook_inbound_events
  alter column business_id drop not null;

-- ── 2. Deduplicación de los mensajes sin local ───────────────────────
--
-- El gemelo de `uq_webhook_events_business_provider_hash` para las filas
-- donde aquel no puede actuar. Sin esto, dos entregas del mismo mensaje
-- son dos filas y el cliente recibe la respuesta dos veces.
create unique index if not exists uq_webhook_events_plataforma_hash
  on public.webhook_inbound_events(provider, message_id_hash)
  where business_id is null;

-- Y el gemelo de `uq_webhook_inbox_processing_stream`: la última barrera
-- contra dos respuestas concurrentes al MISMO contacto. Sin él, un cliente
-- que manda dos mensajes seguidos podría tener dos workers contestándole a
-- la vez, cada uno sin ver lo que hizo el otro.
create unique index if not exists uq_webhook_inbox_plataforma_stream
  on public.webhook_inbound_events(provider, stream_key_hash)
  where status = 'processing' and business_id is null;

-- El índice de ORDEN no necesita gemelo: no es único, así que agrupa las
-- filas de negocio nulo entre sí sin ayuda. Lo que sí necesita arreglo es
-- la consulta que lo usa — ver el punto 4.
create index if not exists idx_webhook_inbox_plataforma_orden
  on public.webhook_inbound_events(
    provider, stream_key_hash, received_at, id
  )
  where status in ('pending', 'processing') and business_id is null;

-- ── 3. Encolar sin local ─────────────────────────────────────────────
--
-- ⚠️ Esta función se copia de la versión VIVA (`schema.sql`), no de la
-- original de `migration-inbox-webhooks.sql`. Entre medias creció con el
-- agrupado de textos rápidos (`migration-agrupado-webhooks.sql`): la ventana
-- durable de 3 s, el lote por conversación y las fronteras que una imagen o
-- un audio ponen entre dos tandas de texto. Recrearla desde la versión
-- antigua habría BORRADO todo eso en silencio — el debounce dejaría de
-- existir y cada palabra suelta del cliente sería una respuesta pagada.
--
-- Cambia solo lo que el negocio nulo exige:
--
--   · se retira «El negocio es obligatorio»;
--   · el advisory lock usa `coalesce(..., 'plataforma')`, porque
--     `null || ':'` es NULL y el lock se calcularía sobre nada;
--   · `on conflict` deja de nombrar su índice (ahora hay dos que pueden
--     atrapar el duplicado y solo se puede nombrar uno);
--   · las comparaciones del agrupado pasan a `is not distinct from`, o el
--     debounce no vería nunca dos mensajes del mismo cliente como del mismo
--     stream y respondería a cada uno por separado.

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
    coalesce(p_business_id::text, 'plataforma') || ':' || p_provider || ':' || p_stream_key_hash,
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
  on conflict do nothing
  returning id into v_event_id;

  if not found then
    return false;
  end if;

  if v_is_text then
    update public.webhook_inbound_events as queued
    set available_at = greatest(queued.available_at, v_quiet_until),
        updated_at = clock_timestamp()
    where queued.business_id is not distinct from p_business_id
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
        where boundary.business_id is not distinct from queued.business_id
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

-- ── 4. El FIFO por conversación, con negocio nulo ────────────────────
--
-- ⚠️ ESTE es el arreglo que no se ve. Las comparaciones que agrupan una
-- conversación usaban `earlier.business_id = event.business_id`, y en SQL
-- `null = null` no es cierto: es NULL. Con negocio nulo el freno
-- desaparecía y dos mensajes seguidos del mismo cliente se procesaban a la
-- vez y en cualquier orden — escribe «1» y luego «2», y le responden al
-- revés.
--
-- `is not distinct from` trata dos NULL como iguales y deja EXACTAMENTE
-- igual el caso con negocio, que es el único que existía hasta hoy. Son las
-- cuatro comparaciones de misma-conversación; la quinta del cuerpo ya era
-- `is distinct from` (comprueba coherencia del lote) y se queda como está.
-- Igual que la anterior, se copia de la versión VIVA con sus lotes.

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
      and event.business_id is not distinct from v_terminal_head.business_id
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
        where earlier.business_id is not distinct from event.business_id
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
        where member.business_id is not distinct from v_head.business_id
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
            where boundary.business_id is not distinct from v_head.business_id
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

revoke all on function public.enqueue_webhook_event(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.lease_webhook_events(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.enqueue_webhook_event(uuid, text, text, text, jsonb)
  to service_role;
grant execute on function public.lease_webhook_events(text, integer, integer)
  to service_role;

-- ── 5. El consumo entrante no se le cobra a nadie ────────────────────
--
-- ⚠️ Este es el fallo que SOLO aparece con datos, y es el motivo de la regla
-- de sembrar el ensayo: `webhook_inbound_events` tiene un disparador que
-- anota el mensaje entrante en `message_usage_events`, y esa tabla exige
-- `business_id not null`. Sin el corte de aquí abajo, encolar un mensaje del
-- marketplace no fallaba «un poco»: abortaba la inserción entera y el
-- mensaje no llegaba a la cola.
--
-- Un mensaje de antes de elegir local es de la PLATAFORMA, no de un negocio.
-- Cargárselo a un local que el cliente elija después sería inventarle gasto,
-- y es la misma regla que ya sigue el saliente.

create or replace function public.record_inbound_message_usage()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_message_type text;
  v_inbound_hash text;
begin
  -- Sin `business_id` el mensaje llegó al número de la PLATAFORMA y el
  -- cliente todavía no eligió local: no es consumo de ningún negocio, así
  -- que no se le cobra a nadie. Es la misma regla que el saliente, donde
  -- `recordOutboundUsage` con negocio nulo tampoco escribe.
  --
  -- ⚠️ Sin este corte, `message_usage_events.business_id not null` abortaba
  -- la inserción ENTERA en la cola: el mensaje del marketplace ni se
  -- encolaba. Solo aparece con datos — sobre una tabla vacía el trigger no
  -- llega a dispararse.
  if new.stream_key_hash is null or new.business_id is null then
    return new;
  end if;

  v_message_type := case new.payload #>> '{content,kind}'
    when 'text' then 'text'
    when 'image' then 'image'
    when 'audio' then 'audio'
    else 'other'
  end;
  v_inbound_hash := encode(digest(
    coalesce(nullif(new.payload ->> 'inboundId', ''), new.message_id_hash),
    'sha256'
  ), 'hex');

  insert into public.message_usage_events (
    business_id, provider, direction, message_type, contact_key_hash,
    source_kind, source_key, occurred_at
  ) values (
    new.business_id,
    new.provider,
    'inbound',
    v_message_type,
    new.stream_key_hash,
    'webhook',
    'inbound:' || new.provider || ':' || v_inbound_hash,
    new.received_at
  )
  on conflict (business_id, source_key) do nothing;

  return new;
end;
$$;

revoke all on function public.record_inbound_message_usage()
  from public, anon, authenticated;

-- ============================================================================
-- EL MENÚ RESPONDE AL INSTANTE: TOCAR UN BOTÓN NO ESPERA TRES SEGUNDOS
--
-- Pedido del dueño (2026-09-23): «el tiempo de respuesta en WhatsApp vamos a
-- dejarlo lo más rápido posible… antes parecía lento, como de 3 segundos».
--
-- ── EL FALLO ────────────────────────────────────────────────────────────────
--
-- `enqueue_webhook_event` abre una ventana de silencio de TRES SEGUNDOS para
-- todo lo que llega como `content.kind = 'text'`. Existe por una buena razón:
-- juntar los mensajes que el cliente escribe a trozos —«hola» … «quiero
-- pizza» … «grande»— y contestar UNA vez en vez de tres.
--
-- El problema es que `webhooks.routes.ts` convierte **las respuestas
-- interactivas en texto**: tanto Meta como YCloud toman el `button_reply` o el
-- `list_reply` y devuelven `{ kind: 'text' }`. Se hizo a propósito —el menú
-- entiende números y títulos, y unificarlo evitó duplicar el emparejamiento—
-- pero tuvo un efecto que nadie midió:
--
--     **CADA TOQUE DEL MENÚ ESPERABA 3 SEGUNDOS**, más hasta 1 s del worker.
--
-- Y esa espera no sirve de nada ahí: **una elección no se puede fragmentar**.
-- Un botón llega entero y de una vez. Las fotos, los audios y las ubicaciones
-- ya entran al instante (`else now()`); lo elegido debía entrar igual.
--
-- ── EL ARREGLO ──────────────────────────────────────────────────────────────
--
-- El payload ahora marca lo elegido con `content.interactivo = true`, y aquí
-- eso deja de contar como «texto libre» en los TRES sitios donde el texto
-- recibe trato especial:
--
--   1. `available_at` → entra con `now()` en vez de esperar la ventana;
--   2. NO extiende la ventana de los textos anteriores del mismo stream;
--   3. SÍ actúa de FRONTERA, como una foto: lo escrito antes de tocar un botón
--      pertenece a otra conversación y no debe juntarse con lo de después.
--
-- ⚠️ EL TEXTO ESCRITO NO CAMBIA. Sigue esperando sus tres segundos y sigue
-- agrupándose, que es para lo que se construyó todo esto. Lo único que cambia
-- es dejar de esperar donde esperar no servía.
--
-- ⚠️ Compatible con lo ya encolado: un evento viejo no trae la marca, y
-- `coalesce(..., false)` lo trata como texto libre, exactamente como hoy.
-- ============================================================================

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
  -- ⚠️ Antes se llamaba `v_is_text`. Ahora es «texto LIBRE»: lo que el cliente
  -- ESCRIBIÓ, frente a lo que ELIGIÓ tocando un botón.
  v_es_texto_libre boolean;
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

  v_es_texto_libre := coalesce((
    p_payload #>> '{content,kind}' = 'text'
    and jsonb_typeof(p_payload #> '{content,text}') = 'string'
    -- Lo elegido NO es texto libre: llega entero y no espera a nadie.
    and coalesce((p_payload #>> '{content,interactivo}')::boolean, false) = false
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
    case when v_es_texto_libre then v_quiet_until else now() end,
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

  if v_es_texto_libre then
    update public.webhook_inbound_events as queued
    set available_at = greatest(queued.available_at, v_quiet_until),
        updated_at = clock_timestamp()
    where queued.business_id is not distinct from p_business_id
      and queued.provider = p_provider
      and queued.stream_key_hash = p_stream_key_hash
      and queued.status = 'pending'
      and queued.payload #>> '{content,kind}' = 'text'
      and jsonb_typeof(queued.payload #> '{content,text}') = 'string'
      -- Una elección pendiente no se retrasa por un texto posterior: ya entró
      -- con `now()` y su respuesta no depende de lo que se escriba después.
      and coalesce((queued.payload #>> '{content,interactivo}')::boolean, false) = false
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
            -- ⚠️ Una ELECCIÓN también es frontera: lo escrito antes de tocar un
            -- botón pertenece a otra conversación. Sin esto, un texto anterior
            -- se juntaría con otro posterior saltándose la elección de en medio.
            or coalesce((boundary.payload #>> '{content,interactivo}')::boolean, false)
            or boundary.payload ? '_inboxBatch'
          )
      );
  end if;

  return true;
end;
$$;

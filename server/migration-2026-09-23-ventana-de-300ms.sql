-- ============================================================================
-- LA VENTANA DE AGRUPADO BAJA DE 3 SEGUNDOS A 300 ms
--
-- Pedido del dueño (2026-09-23): «quiero que todo sea en el acto… baja la
-- ventana de tiempo todo lo que puedas».
--
-- ── LA MEDICIÓN QUE LO DECIDE ───────────────────────────────────────────────
--
-- Se midieron los huecos REALES entre mensajes entrantes consecutivos del
-- mismo cliente, en producción (`conversation_history`, role = 'user'):
--
--     huecos medidos ......................... 128
--     el MÁS CORTO de toda la historia ....... 5,67 s
--     por debajo de 5 s ......................    0
--     por debajo de 3 s ......................    0   ← la ventana actual
--
-- **La ventana de 3 segundos no ha agrupado NADA jamás.** Todo cliente que
-- escribe paga 3 segundos para proteger un caso que no se ha dado ni una vez.
--
-- ── POR QUÉ 300 ms Y NO CERO ────────────────────────────────────────────────
--
-- 300 ms deja **19 veces de margen** sobre el hueco más ajustado que ha
-- existido, y conserva la red para lo único que sí puede pasar de verdad: que
-- WhatsApp entregue DOS WEBHOOKS CASI A LA VEZ —un reintento suyo, o un envío
-- doble del cliente— y el bot conteste dos veces. Cada respuesta saliente se
-- paga, así que esa red cuesta menos de lo que ahorra.
--
-- Quitarla del todo también quitaría el agrupado, que es una pieza con nombre
-- y pruebas (`_inboxBatch`), no un retraso suelto.
--
-- ── ⚠️ EL SUELO YA NO ES ESTA VENTANA ───────────────────────────────────────
--
-- `webhook-inbox-worker` sondea la cola **cada 1000 ms**, pase lo que pase. Con
-- la ventana en 300 ms, lo que manda es el sondeo: un mensaje escrito tarda
-- 300 ms + hasta 1 s de sondeo.
--
-- Bajar ese suelo NO se hace aquí y no es gratis: doblar el sondeo dobla las
-- consultas a la base de TODOS los negocios, todo el día, y el egress de
-- Supabase ya fue un problema real. Lo instantáneo de verdad sería
-- LISTEN/NOTIFY, pero el worker habla por PostgREST y eso pide conexión
-- directa: es un cambio de arquitectura, no un número.
--
-- ⚠️ Lo ELEGIDO (botones y listas) ya entra con `now()` desde
-- `migration-2026-09-23-el-menu-responde-al-instante.sql`. Esto solo afecta a
-- lo ESCRITO.
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
  -- «texto LIBRE»: lo que el cliente ESCRIBIÓ, frente a lo que ELIGIÓ tocando
  -- un botón. Lo elegido llega entero y no espera a nadie.
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
    -- Lo elegido (botón o fila de lista) NO es texto libre.
    and coalesce((p_payload #>> '{content,interactivo}')::boolean, false) = false
  ), false);
  perform pg_advisory_xact_lock(hashtextextended(
    coalesce(p_business_id::text, 'plataforma') || ':' || p_provider || ':' || p_stream_key_hash,
    0
  ));
  v_received_at := clock_timestamp();
  -- ⚠️ 300 ms, no 3 segundos. Medido: el hueco más corto entre dos mensajes
  -- de un mismo cliente en toda la historia de producción es 5,67 s — 19 veces
  -- esta ventana. Lo que se conserva es la red contra dos webhooks casi
  -- simultáneos, que sí ocurre y costaría una respuesta de más.
  v_quiet_until := v_received_at + interval '300 milliseconds';

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
      -- Una elección pendiente no se retrasa por un texto posterior.
      and coalesce((queued.payload #>> '{content,interactivo}')::boolean, false) = false
      and not (queued.payload ? '_inboxBatch')
      and (queued.received_at, queued.id) <= (v_received_at, v_event_id)
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
            -- Una ELECCIÓN también es frontera.
            or coalesce((boundary.payload #>> '{content,interactivo}')::boolean, false)
            or boundary.payload ? '_inboxBatch'
          )
      );
  end if;

  return true;
end;
$$;

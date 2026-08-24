-- ═══════════════════════════════════════════════════════════════════════════
-- EL TECHO DE GASTO DEL MARKETPLACE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Desde el 1 de octubre de 2026 Meta cobra CADA mensaje saliente, incluidos
-- los de servicio. Y el número de Umbani contesta a todo el que escribe.
--
-- El techo ya existía… para el canal PROPIO de un negocio
-- (`claim_miniapp_reply`, 2026-08-13): a partir de la 5ª respuesta en una hora
-- se añade el teléfono del local, y pasada la 10ª el bot calla 24 h. Pero esa
-- función se llama desde `bot-conversation.ts`, y el marketplace no pasa por
-- ahí. Resultado: **el número compartido responde sin límite**, y con un local
-- o con cincuenta el coste lo paga siempre la plataforma.
--
-- ⚠️ El contador va por CLIENTE, no por (negocio, cliente). Antes de elegir
-- local no hay negocio al que cargárselo, y quien escribe por molestar no ha
-- elegido ninguno. Es la misma razón por la que `marketplace_conversations` es
-- la única tabla sin `business_id`.
--
-- ⚠️ El tope es ALTO a propósito: 25 respuestas por hora. En los locales que se
-- piden dentro del chat (`pide_en_chat`), armar un pedido son fácilmente 15-25
-- mensajes —categoría, local, varios productos, sus opciones, dirección,
-- método de pago, confirmación— y un tope bajo cortaría a un cliente de verdad
-- a mitad de compra. Lo que este techo existe para parar no es al que pide
-- mucho: es al que manda quinientos.
--
-- ⚠️ El silencio son 12 h y no 24 como en el canal propio. Ahí el silenciado es
-- cliente de UN local; aquí lo dejaría fuera del marketplace ENTERO, de todos
-- los locales a la vez. Media jornada corta igual a quien molesta y no le
-- cuesta el día a quien se pasó de vueltas.

-- ── 1. El contador, junto a la conversación que ya existe ──────────────────
--
-- Va en `marketplace_conversations` y no en una tabla nueva porque es
-- exactamente el mismo sujeto: la conversación de un cliente con la
-- plataforma. Una tabla aparte obligaría a mantener dos filas por cliente en
-- sincronía sin ganar nada.
alter table public.marketplace_conversations
  add column if not exists reply_count integer not null default 0,
  add column if not exists reply_window_start timestamptz,
  add column if not exists muted_until timestamptz,
  -- El id del mensaje ENTRANTE que provocó la última respuesta contada. La
  -- entrada es *at-least-once*: si la confirmación a PostgreSQL no llega, el
  -- worker reintenta y el mismo mensaje se procesa otra vez. Sin esto, cinco
  -- reintentos silenciaban a un cliente legítimo — el mismo fallo que ya se
  -- corrigió en el canal propio (`migration-2026-08-15-reclamo-idempotente`).
  add column if not exists last_reply_message_id text;

alter table public.marketplace_conversations
  drop constraint if exists marketplace_conversations_reply_count_check;
alter table public.marketplace_conversations
  add constraint marketplace_conversations_reply_count_check
  check (reply_count >= 0);

-- ── 2. Reclamar una respuesta ──────────────────────────────────────────────
--
-- Copia fiel de `claim_miniapp_reply`, con tres diferencias y ninguna casual:
--
--   · La llave es el CLIENTE. No hay negocio antes de elegir local.
--   · No existe `con_telefono`: ese aviso añade el teléfono del local al mismo
--     mensaje, y aquí todavía no hay local del que sacarlo. Los estados son
--     dos: se contesta, o se calla.
--   · El silencio es más corto, por lo que dice la cabecera.
--
-- ⚠️ `security definer` con `search_path` fijo, como todas: `marketplace_conversations`
-- tiene RLS y `revoke all` incluido `service_role`.
create or replace function public.claim_marketplace_reply(
  p_customer_id uuid,
  p_tope integer default 25,
  p_silencio_horas integer default 12,
  -- Nulo = no se puede identificar el mensaje. Se cuenta igual: contar de más
  -- es menos malo que no contar.
  p_message_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fila public.marketplace_conversations%rowtype;
  v_ahora timestamptz := now();
  v_cuenta integer;
begin
  -- Sin cliente no hay a quién contarle nada: se atiende. Quedarse mudo por un
  -- problema nuestro deja sin servicio a alguien de verdad, mientras que
  -- equivocarse al revés cuesta un mensaje.
  if p_customer_id is null then
    return jsonb_build_object('permitido', true, 'respuestas', 0);
  end if;

  -- La conversación puede no existir todavía: el primer mensaje de alguien que
  -- nunca escribió llega antes de que nadie la cree.
  insert into public.marketplace_conversations (customer_id)
  values (p_customer_id)
  on conflict (customer_id) do nothing;

  select * into v_fila
  from public.marketplace_conversations
  where customer_id = p_customer_id
  for update;

  if v_fila.muted_until is not null and v_fila.muted_until > v_ahora then
    return jsonb_build_object(
      'permitido', false, 'motivo', 'silenciado',
      'respuestas', coalesce(v_fila.reply_count, 0)
    );
  end if;

  -- ── El mismo mensaje otra vez ────────────────────────────────────────────
  -- Se devuelve lo que le tocaba y NO se suma. Un reintento del worker no
  -- puede acercar a nadie al silencio.
  if p_message_id is not null
     and v_fila.last_reply_message_id is not distinct from p_message_id then
    return jsonb_build_object(
      'permitido', true,
      'respuestas', coalesce(v_fila.reply_count, 0),
      'repetido', true
    );
  end if;

  if v_fila.reply_window_start is null
     or v_fila.reply_window_start < v_ahora - interval '1 hour' then
    v_cuenta := 1;
    update public.marketplace_conversations
       set reply_window_start = v_ahora,
           reply_count = 1,
           last_reply_message_id = p_message_id,
           updated_at = v_ahora
     where id = v_fila.id;
  else
    v_cuenta := coalesce(v_fila.reply_count, 0) + 1;
    update public.marketplace_conversations
       set reply_count = v_cuenta,
           last_reply_message_id = p_message_id,
           updated_at = v_ahora
     where id = v_fila.id;
  end if;

  if v_cuenta > p_tope then
    update public.marketplace_conversations
       set muted_until = v_ahora + make_interval(hours => p_silencio_horas),
           updated_at = v_ahora
     where id = v_fila.id;
    return jsonb_build_object(
      'permitido', false, 'motivo', 'silenciado', 'respuestas', v_cuenta
    );
  end if;

  return jsonb_build_object('permitido', true, 'respuestas', v_cuenta);
end;
$$;

-- ⚠️ NO toca `version`. El bloqueo optimista de `advance_marketplace_conversation`
-- protege el estado del menú —dónde está el cliente, qué lleva en el carrito—,
-- y subirlo aquí haría que contar una respuesta invalidara el avance que se
-- está guardando en el mismo mensaje: el cliente elegiría un local y su
-- elección se perdería con un «conflicto».

revoke all on function public.claim_marketplace_reply(uuid, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.claim_marketplace_reply(uuid, integer, integer, text)
  to service_role;

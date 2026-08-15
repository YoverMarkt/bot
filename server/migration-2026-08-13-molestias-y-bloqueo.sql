-- ═══════════════════════════════════════════════════════════════════════════
-- QUIEN ESCRIBE POR MOLESTAR: TECHO AUTOMÁTICO Y BLOQUEO DEL DUEÑO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Desde el 2026-08-12 el modo mini app manda el enlace SIEMPRE, también dentro
-- de las 24 h: quien borraba el chat se quedaba sin poder pedir. El efecto
-- secundario es que quien escribe por molestar recibe una respuesta por
-- mensaje — y desde el 1 de octubre de 2026 cada respuesta se paga.
--
-- Dos frenos, y son distintos a propósito:
--
--   · `muted_until` — AUTOMÁTICO. Se pone solo cuando alguien pasa del techo.
--     Es temporal (24 h) porque un contador no puede condenar a nadie: quien
--     escribió doce veces un martes puede ser un cliente agobiado.
--   · `blocked_at` — MANUAL. Lo pone el dueño desde su panel, no caduca, y es
--     total: el bot deja de contestarle y la mini app le rechaza el pedido
--     aunque tenga su enlace guardado.
--
-- ⚠️ El contador vive en la fila del cliente y NO en memoria. Un `Map` del
-- proceso se pierde al desplegar y con dos instancias cada una lleva su cuenta
-- — es el mismo error que ya se corrigió con el envío del enlace, y aquí sería
-- peor: el que molesta solo tendría que esperar a un despliegue.
--
-- Aditiva e idempotente. No toca ni una fila existente: las columnas nacen
-- nulas, que significa «ni silenciado ni bloqueado».

begin;

alter table public.business_customers
  add column if not exists blocked_at        timestamptz,
  add column if not exists muted_until       timestamptz,
  -- Cuándo empezó la hora que se está contando. Nulo = nunca se le respondió.
  add column if not exists reply_window_start timestamptz,
  add column if not exists reply_count        integer not null default 0;

alter table public.business_customers
  drop constraint if exists business_customers_respuestas_check;
alter table public.business_customers
  add constraint business_customers_respuestas_check
  check (reply_count >= 0);

-- Para la lista de bloqueados del panel: son pocos, pero se consultan por
-- negocio y sin índice se recorrería la tabla entera de clientes.
create index if not exists idx_business_customers_bloqueados
  on public.business_customers (business_id, blocked_at)
  where blocked_at is not null;

-- ── El reclamo de una respuesta ────────────────────────────────────────────
--
-- Una sola operación atómica que hace las cuatro preguntas y deja la cuenta
-- puesta. Comprobar primero y escribir después deja una carrera en la que dos
-- mensajes simultáneos del mismo contacto leen el mismo número — que es justo
-- lo que hace quien escribe rápido para molestar.
--
-- Devuelve:
--   permitido  · false si está bloqueado o silenciado
--   motivo     · 'ok' | 'bloqueado' | 'silenciado'
--   respuestas · cuántas van en esta hora (con esta incluida)
--
-- ⚠️ La ventana es RODANTE POR TRAMOS, no deslizante: se cuenta desde la
-- primera respuesta y se reinicia a la hora. Una ventana deslizante de verdad
-- obligaría a guardar cada marca de tiempo, y el resultado práctico es el
-- mismo para lo que esto decide.
create or replace function public.claim_miniapp_reply(
  p_business_id uuid,
  p_customer_id uuid,
  p_aviso_desde integer default 5,
  p_tope        integer default 10,
  p_silencio_horas integer default 24
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fila public.business_customers%rowtype;
  v_ahora timestamptz := now();
  v_cuenta integer;
begin
  if p_business_id is null or p_customer_id is null then
    return jsonb_build_object('permitido', true, 'motivo', 'ok', 'respuestas', 0);
  end if;

  -- La fila puede no existir si el cliente nunca pidió nada.
  insert into public.business_customers (business_id, customer_id)
  values (p_business_id, p_customer_id)
  on conflict (business_id, customer_id) do nothing;

  -- `for update` serializa los mensajes que llegan a la vez del mismo cliente.
  select * into v_fila
  from public.business_customers
  where business_id = p_business_id and customer_id = p_customer_id
  for update;

  if v_fila.blocked_at is not null then
    return jsonb_build_object('permitido', false, 'motivo', 'bloqueado', 'respuestas', 0);
  end if;

  if v_fila.muted_until is not null and v_fila.muted_until > v_ahora then
    return jsonb_build_object('permitido', false, 'motivo', 'silenciado', 'respuestas', 0);
  end if;

  -- Hora nueva: se reinicia la cuenta. También cuando nunca hubo ninguna.
  if v_fila.reply_window_start is null
     or v_fila.reply_window_start < v_ahora - interval '1 hour' then
    v_cuenta := 1;
    update public.business_customers
       set reply_window_start = v_ahora,
           reply_count = 1,
           updated_at = v_ahora
     where id = v_fila.id;
  else
    v_cuenta := coalesce(v_fila.reply_count, 0) + 1;
    update public.business_customers
       set reply_count = v_cuenta,
           updated_at = v_ahora
     where id = v_fila.id;
  end if;

  -- Pasado el tope se calla, y el silencio NO se levanta a la hora siguiente:
  -- con una ventana que se reinicia sola, quien molesta con paciencia pagaría
  -- el tope entero cada hora, todo el día.
  if v_cuenta > p_tope then
    update public.business_customers
       set muted_until = v_ahora + make_interval(hours => p_silencio_horas),
           updated_at = v_ahora
     where id = v_fila.id;
    return jsonb_build_object('permitido', false, 'motivo', 'silenciado', 'respuestas', v_cuenta);
  end if;

  return jsonb_build_object(
    'permitido', true,
    -- A partir del aviso, la respuesta lleva además el teléfono del local: no
    -- cuesta un mensaje más, es el mismo con una línea de ayuda.
    'motivo', case when v_cuenta >= p_aviso_desde then 'con_telefono' else 'ok' end,
    'respuestas', v_cuenta
  );
end;
$$;

revoke all on function public.claim_miniapp_reply(uuid, uuid, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_miniapp_reply(uuid, uuid, integer, integer, integer)
  to service_role;

commit;

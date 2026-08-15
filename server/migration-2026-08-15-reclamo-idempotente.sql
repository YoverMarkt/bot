-- ═══════════════════════════════════════════════════════════════════════════
-- EL MISMO MENSAJE NO SE CUENTA DOS VECES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El techo de respuestas por hora (2026-08-13) cuenta ANTES de enviar, que es
-- lo correcto: contar después dejaría una carrera en la que dos mensajes
-- simultáneos leen el mismo número.
--
-- Pero la entrada de mensajes es **at-least-once** a propósito: si la
-- confirmación a PostgreSQL no llega, el worker reintenta el evento y el
-- mensaje se procesa otra vez (`webhook-inbox-worker.ts`). Con el contador
-- ciego, ese reintento sumaba una respuesta más. Cinco reintentos de un mismo
-- cliente legítimo podían dejarlo silenciado 24 h sin haber escrito de más.
--
-- La solución es la de siempre en este proyecto: reclamar por ID. Se guarda el
-- identificador del último mensaje contado y, si vuelve el mismo, se devuelve
-- la MISMA decisión sin sumar.
--
-- ⚠️ Sin `begin`/`commit`: la transacción la abre el ejecutor
-- (`tests/migraciones.mjs`), y cerrarla aquí dejaría el registro fuera. Lo
-- vigila `migraciones-guardian.test.js`.

alter table public.business_customers
  add column if not exists last_reply_message_id text;

-- La firma cambia (un parámetro más), así que la anterior se retira: sin esto
-- PostgreSQL se queda con las dos y `db.rpc` elegiría por número de argumentos
-- sin que nadie se entere.
drop function if exists public.claim_miniapp_reply(uuid, uuid, integer, integer, integer);

create or replace function public.claim_miniapp_reply(
  p_business_id uuid,
  p_customer_id uuid,
  p_aviso_desde integer default 5,
  p_tope        integer default 10,
  p_silencio_horas integer default 24,
  -- El id del mensaje ENTRANTE que provocó esta respuesta. Nulo = no se puede
  -- identificar (el simulador, Telegram sin id): entonces se cuenta como
  -- antes, porque el riesgo de contar de más es menor que el de no contar.
  p_message_id  text default null
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

  insert into public.business_customers (business_id, customer_id)
  values (p_business_id, p_customer_id)
  on conflict (business_id, customer_id) do nothing;

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

  -- ── El mismo mensaje otra vez ────────────────────────────────────────────
  -- Se devuelve la decisión que le tocaba, recalculada del contador que ya
  -- tiene, y NO se suma. El motivo se recalcula en vez de guardarse porque
  -- depende solo de la cuenta: guardarlo sería una segunda fuente de verdad.
  if p_message_id is not null
     and v_fila.last_reply_message_id is not distinct from p_message_id then
    return jsonb_build_object(
      'permitido', true,
      'motivo', case when coalesce(v_fila.reply_count, 0) >= p_aviso_desde
                     then 'con_telefono' else 'ok' end,
      'respuestas', coalesce(v_fila.reply_count, 0),
      'repetido', true
    );
  end if;

  if v_fila.reply_window_start is null
     or v_fila.reply_window_start < v_ahora - interval '1 hour' then
    v_cuenta := 1;
    update public.business_customers
       set reply_window_start = v_ahora,
           reply_count = 1,
           last_reply_message_id = p_message_id,
           updated_at = v_ahora
     where id = v_fila.id;
  else
    v_cuenta := coalesce(v_fila.reply_count, 0) + 1;
    update public.business_customers
       set reply_count = v_cuenta,
           last_reply_message_id = p_message_id,
           updated_at = v_ahora
     where id = v_fila.id;
  end if;

  if v_cuenta > p_tope then
    update public.business_customers
       set muted_until = v_ahora + make_interval(hours => p_silencio_horas),
           updated_at = v_ahora
     where id = v_fila.id;
    return jsonb_build_object('permitido', false, 'motivo', 'silenciado', 'respuestas', v_cuenta);
  end if;

  return jsonb_build_object(
    'permitido', true,
    'motivo', case when v_cuenta >= p_aviso_desde then 'con_telefono' else 'ok' end,
    'respuestas', v_cuenta
  );
end;
$$;

revoke all on function public.claim_miniapp_reply(uuid, uuid, integer, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.claim_miniapp_reply(uuid, uuid, integer, integer, integer, text)
  to service_role;

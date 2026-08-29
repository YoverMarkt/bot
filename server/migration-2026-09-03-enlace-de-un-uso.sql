-- ═══════════════════════════════════════════════════════════════════════════
-- EL ENLACE ES DE UN SOLO USO: UNO VIVO A LA VEZ
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Decisión del dueño (2026-08-31): «quiero que sea estricto con bloqueos de
-- enlace, porque si estás pidiendo en ese momento termina el proceso, o
-- escribes MENÚ y listo».
--
-- ── QUÉ AGUJERO CIERRA ─────────────────────────────────────────────────────
--
-- El chat YA impide ir hacia atrás: al elegir un local se pone
-- `shopping_locked` y cualquier mensaje posterior choca contra «Tienes un
-- pedido en proceso en X». Comprobado camino a camino en `marketplace-entry`.
--
-- Pero los ENLACES no. `issueLink` emitía uno nuevo en cada elección y **no
-- revocaba ninguno**: `revoked_at` existía, lo miraba `checkSession`, lo
-- traducía `rejectionMessage`… y NADIE lo escribía jamás. Construido y
-- desconectado.
--
-- El efecto es exactamente lo que el dueño describe: quien ha pedido en cinco
-- locales tiene cinco enlaces vivos en su chat. Sube tres mensajes, toca el de
-- la pizzería y está pidiendo allí con la conversación puesta en otro sitio —
-- el candado del chat no se entera, porque el enlace no pasa por el chat.
--
-- ── LA REGLA ───────────────────────────────────────────────────────────────
--
-- Al emitir un enlace se revocan los demás enlaces vivos de esa persona, CON
-- DOS EXCEPCIONES. Las dos existen para que «estricto» no signifique «trampa»:
--
--  1. **El mismo local no se toca.** Pedir el enlace otra vez del sitio donde
--     ya estás no puede matarte la app que tienes abierta: el carrito vive en
--     memoria, así que recargar con un token nuevo lo vaciaría. Y no protege
--     de nada — es la misma persona en el mismo local.
--
--  2. **Nunca se revoca donde se DEBE dinero.** Los datos bancarios viven
--     detrás de la sesión (`GET /payment-info` y `GET /orders/:id` exigen
--     enlace). Revocar el enlace de un local con un pedido en `esperando_pago`
--     dejaría a esa persona sin poder pagar lo que ya encargó — y, con el
--     freno de #296, tampoco podría pedir en otro sitio hasta que caduque.
--     Un callejón sin salida construido a propósito. El camino del dinero no
--     se corta nunca.
--
-- ⚠️ FALLA HACIA NO REVOCAR. Si no se encuentra la sesión que hay que
-- conservar, no se toca nada: revocar de más deja a un cliente legítimo fuera
-- de su tienda, y eso es peor que dejar un enlace viejo vivo un rato más.
--
-- ⚠️ Es una FUNCIÓN, no un disparador, al revés que `orders_release_shopping_lock`.
-- Allí la regla tenía que valer para cualquier camino que resolviera un pedido,
-- incluidos los que aún no existen. Aquí solo hay un sitio en todo el sistema
-- que emite enlaces —`storefront-link.ts`— y un `after insert` sobre
-- `storefront_sessions` revocaría también las sesiones que algún día se creen
-- para otra cosa. La regla es «al emitir un enlace del bot», no «al existir
-- una fila».
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.revoke_other_storefront_sessions(
  p_customer_id     uuid,
  p_keep_session_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_local_vigente uuid;
  v_revocadas     integer;
begin
  if p_customer_id is null or p_keep_session_id is null then
    return 0;
  end if;

  select business_id into v_local_vigente
    from public.storefront_sessions
   where id = p_keep_session_id;

  -- La sesión recién creada no aparece: algo va mal y no es momento de
  -- revocar nada. Fallar hacia dejar enlaces vivos es recuperable; fallar
  -- hacia matarlos todos deja a la persona fuera de su propia tienda.
  if v_local_vigente is null then
    return 0;
  end if;

  with revocadas as (
    update public.storefront_sessions as sesion
       set revoked_at = now()
     where sesion.customer_id = p_customer_id
       and sesion.revoked_at is null
       and sesion.id <> p_keep_session_id
       -- Excepción 1: el local que se acaba de entregar.
       and sesion.business_id <> v_local_vigente
       -- Excepción 2: donde queda un pedido por pagar.
       and not exists (
         select 1
           from public.orders as pedido
          where pedido.customer_id  = p_customer_id
            and pedido.business_id  = sesion.business_id
            and pedido.source       = 'storefront'
            and pedido.status       = 'esperando_pago'
       )
    returning 1
  )
  select count(*)::integer into v_revocadas from revocadas;

  return coalesce(v_revocadas, 0);
end;
$$;

comment on function public.revoke_other_storefront_sessions(uuid, uuid) is
  'Un enlace vivo a la vez por persona. Conserva el del local recién entregado '
  'y el de cualquier local donde quede un pedido en esperando_pago.';

revoke all on function public.revoke_other_storefront_sessions(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_other_storefront_sessions(uuid, uuid)
  to service_role;

-- La búsqueda es «los enlaces vivos de esta persona», y el único índice que
-- había empieza por `expires_at`. Sin este, cada enlace emitido recorrería la
-- tabla entera.
create index if not exists idx_storefront_sessions_por_cliente
  on public.storefront_sessions (customer_id) where revoked_at is null;

-- ── Comprobación inmediata ─────────────────────────────────────────────────
--
-- PostgreSQL no valida el cuerpo de una función plpgsql al crearla: un error
-- ahí dentro solo aparece al EJECUTARLA. Se ejecuta con los tres casos que la
-- pueden romper.
do $comprobacion$
declare
  v_pizza    uuid;
  v_ceviche  uuid;
  v_helado   uuid;
  v_cliente  uuid;
  v_s_pizza  uuid;
  v_s_cevi   uuid;
  v_s_helado uuid;
  v_s_nueva  uuid;
  v_revocadas integer;
  v_estado   timestamptz;
begin
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders, chat_mode
  ) values
    ('pizza-uso-tmp', 'Pizza', 'pizzeria', 'ycloud', '+593900777001', '+593900777001', true, 'miniapp'),
    ('cevi-uso-tmp', 'Cevichería', 'restaurante', 'ycloud', '+593900777002', '+593900777002', true, 'miniapp'),
    ('helado-uso-tmp', 'Heladería', 'heladeria', 'ycloud', '+593900777003', '+593900777003', true, 'miniapp');

  select id into v_pizza   from businesses where slug = 'pizza-uso-tmp';
  select id into v_ceviche from businesses where slug = 'cevi-uso-tmp';
  select id into v_helado  from businesses where slug = 'helado-uso-tmp';

  insert into public.customers (phone) values ('593900777100') returning id into v_cliente;

  -- Tres enlaces vivos: exactamente el agujero que se cierra.
  insert into public.storefront_sessions (business_id, customer_id, token_hash, contact_phone, expires_at)
  values (v_pizza,   v_cliente, repeat('1', 64), '593900777100', null) returning id into v_s_pizza;
  insert into public.storefront_sessions (business_id, customer_id, token_hash, contact_phone, expires_at)
  values (v_ceviche, v_cliente, repeat('2', 64), '593900777100', null) returning id into v_s_cevi;
  insert into public.storefront_sessions (business_id, customer_id, token_hash, contact_phone, expires_at)
  values (v_helado,  v_cliente, repeat('3', 64), '593900777100', null) returning id into v_s_helado;

  -- ── 1. En la pizzería DEBE dinero: ese enlace es intocable ───────────────
  insert into public.orders (
    business_id, customer_id, contact_phone, source, status, subtotal, total
  ) values (v_pizza, v_cliente, '593900777100', 'storefront', 'esperando_pago', 9, 9);

  -- El cliente elige la HELADERÍA: se le emite un enlace nuevo de ese local.
  insert into public.storefront_sessions (business_id, customer_id, token_hash, contact_phone, expires_at)
  values (v_helado, v_cliente, repeat('4', 64), '593900777100', null) returning id into v_s_nueva;

  v_revocadas := public.revoke_other_storefront_sessions(v_cliente, v_s_nueva);

  -- Solo la cevichería sobra: la pizzería debe dinero y la heladería es el
  -- local vigente (dos sesiones, la vieja y la nueva).
  if v_revocadas <> 1 then
    raise exception 'debía revocar 1 enlace y revocó %', v_revocadas;
  end if;

  select revoked_at into v_estado from public.storefront_sessions where id = v_s_cevi;
  if v_estado is null then
    raise exception 'el enlace de OTRO local siguió vivo';
  end if;

  select revoked_at into v_estado from public.storefront_sessions where id = v_s_pizza;
  if v_estado is not null then
    raise exception 'se revocó el enlace de un local con un pedido SIN PAGAR';
  end if;

  select revoked_at into v_estado from public.storefront_sessions where id = v_s_helado;
  if v_estado is not null then
    raise exception 'se revocó un enlace del MISMO local que se acaba de entregar';
  end if;

  select revoked_at into v_estado from public.storefront_sessions where id = v_s_nueva;
  if v_estado is not null then
    raise exception 'se revocó el enlace recién emitido';
  end if;

  -- ── 2. Pagar la pizzería deja de protegerla ──────────────────────────────
  update public.orders set status = 'pago_en_revision'
   where business_id = v_pizza and customer_id = v_cliente;

  v_revocadas := public.revoke_other_storefront_sessions(v_cliente, v_s_nueva);
  if v_revocadas <> 1 then
    raise exception 'resuelto el pedido, el enlace de la pizzería debía caer: %', v_revocadas;
  end if;

  -- ── 3. Sin sesión que conservar NO se toca nada ──────────────────────────
  -- Falla hacia dejar enlaces vivos, nunca hacia dejar a alguien fuera.
  v_revocadas := public.revoke_other_storefront_sessions(
    v_cliente, '00000000-0000-0000-0000-000000000000'
  );
  if v_revocadas <> 0 then
    raise exception 'con una sesión inexistente revocó % enlaces', v_revocadas;
  end if;

  delete from businesses where id in (v_pizza, v_ceviche, v_helado);
  delete from public.customers where id = v_cliente;
  raise notice 'ENLACE DE UN USO: uno vivo a la vez, salvo el local vigente y el que debe dinero';
end;
$comprobacion$;

-- ═══════════════════════════════════════════════════════════════════════════
-- EL CANAL PROPIO TAMBIÉN PIDE POR LA MINI APP
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Decisión del dueño (2026-09-16): «lo único que no quiero son locales por menú
-- chat, no es la mejor experiencia de usuario; que todos sean mini app. Y en el
-- panel del superadmin, al crear un local, nada referente a menú chat».
--
-- Ayer se retiró el pedido por chat del MARKETPLACE. El motor
-- (`bot-menu-flow.ts`) siguió en pie porque lo usaba el modo menú del canal
-- PROPIO de un negocio. Hoy se retira entero, y con él el último sitio donde
-- `chat_mode` era una elección.
--
-- ⚠️ RADIO DE DAÑO MEDIDO ANTES, no supuesto:
--   · `business_channel_identifiers` — 0 filas: ningún local tiene canal propio
--   · los dos locales son `whatsapp_provider = 'marketplace'`
--   · `conversation_sessions` — 3 filas, todas de WhatsApp y la última del
--     2026-08-17: `bot-conversation` llevaba un mes sin ejecutarse
--   · ninguna sesión `tg_*` jamás. Telegram importa porque NO pasa por
--     `business_channel_identifiers` —resuelve por slug y lista todos los
--     negocios—, así que era la única puerta que las cero filas no cubrían
--
-- La conversión de más abajo toca UNA fila: La Abuelita, en `menu`. Dentro del
-- marketplace esa columna ya no gobernaba nada —la experiencia la decide el
-- local al entrar—, así que no cambia lo que vive hoy ningún cliente.
--
-- Lo que SIGUE por WhatsApp, intacto: elegir local, la bienvenida, las
-- categorías, la búsqueda, el enlace, los comprobantes, los avisos de estado
-- («tu pedido está en camino») con su mapa, la ubicación y MENÚ.
--
-- Lo que NO toca: pedidos, ventas, catálogo, motor de opciones, motor de
-- margen, el horario, las defensas anti-abuso ni los avisos.


-- ── 1. El único local en modo menú pasa a la mini app ──────────────────────
--
-- ⚠️ EL ORDEN IMPORTA, y es el del 2026-08-21: primero se convierten las filas
-- y solo después se estrecha el CHECK. Al revés, el propio `alter` fallaría
-- sobre las filas que intenta arreglar.
update public.businesses
   set chat_mode = 'miniapp'
 where chat_mode <> 'miniapp';


-- ── 2. El defecto de la columna ────────────────────────────────────────────
--
-- Sin esto, cualquier insert que no nombre `chat_mode` —los hay en las
-- verificaciones— caería en 'menu' y chocaría contra el CHECK nuevo.
alter table public.businesses
  alter column chat_mode set default 'miniapp';


-- ── 3. Un solo modo, y la base lo hace cumplir ─────────────────────────────
--
-- ⚠️ El CHECK de un solo valor NO es un adorno: es un cerrojo. Si mañana un
-- script, la API o código viejo escribieran 'menu', la base lo rechaza en vez
-- de dejar un negocio sin nadie que le conteste. Quitar el campo de la
-- pantalla evita el error de dedo; solo una guarda aquí evita que vuelva a
-- entrar por otra puerta.
alter table public.businesses
  drop constraint if exists businesses_chat_mode_check;

alter table public.businesses
  add constraint businesses_chat_mode_check
  check (chat_mode in ('miniapp'));


-- ── 4. El alta deja de elegir modo, y de exigir tienda para él ─────────────
--
-- Se parte de la ÚLTIMA versión viva —la de
-- `migration-2026-08-21-retirar-el-modo-ia.sql`— y se cambian tres cosas: el
-- defecto, la lista de modos válidos, y se RETIRA la exigencia de pedidos y
-- tienda para el modo mini app.
--
-- ⚠️ Esa exigencia (2026-08-19) existía porque había OTRO modo al que caer: un
-- negocio sin tienda se quedaba en `menu` y atendía igual. Con un solo modo
-- significaría «todo local tiene que vender», y eso es falso — un local oculto
-- mientras carga su catálogo no vende, y tiene que poder crearse y guardarse.
--
-- Lo que protegía sigue cubierto por los dos extremos, y mejor: en el chat,
-- `runMiniappMode` ya responde un recordatorio cuando el negocio no tiene
-- tienda utilizable en vez de mandar un enlace a una app vacía; y
-- `marketplace_categories_disponibles` ya esconde del menú al local que no
-- vende. La validación era la tercera copia, y era la única que rompía el
-- guardado al ocultar un local.
--
-- ⚠️ Es la razón por la que `ClientModal` escribía `chat_mode: 'menu'` al
-- ocultar un local: no era un capricho, era esquivar esta excepción. Retirada
-- la excepción, ocultar un local deja de tocar la columna.
create or replace function public.create_business_onboarding(
  p_business jsonb,
  p_client_email text default null,
  p_password_hash text default null,
  p_monthly_rate numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business public.businesses%rowtype;
  v_name text := btrim(coalesce(p_business ->> 'name', ''));
  v_slug text := btrim(coalesce(p_business ->> 'slug', ''));
  v_whatsapp_number text :=
    btrim(coalesce(p_business ->> 'whatsapp_number', ''));
  v_whatsapp_provider text :=
    coalesce(nullif(btrim(p_business ->> 'whatsapp_provider'), ''), 'ycloud');
  v_client_email text :=
    nullif(btrim(coalesce(p_client_email, '')), '');
  v_password_hash text := nullif(p_password_hash, '');
  v_chat_mode text :=
    coalesce(nullif(btrim(p_business ->> 'chat_mode'), ''), 'miniapp');
  v_plan text :=
    lower(coalesce(nullif(btrim(p_business ->> 'plan'), ''), 'micro'));
  v_plan_definition record;
  v_monthly_rate numeric;
  v_contact_limit integer;
  v_outbound_limit integer;
  v_period_start date :=
    date_trunc('month', timezone('America/Guayaquil', now()))::date;
  v_period_end date :=
    (v_period_start + interval '1 month' - interval '1 day')::date;
begin
  if jsonb_typeof(p_business) is distinct from 'object' then
    raise exception using
      errcode = '22023',
      message = 'Los datos del negocio son inválidos';
  end if;
  if v_name = '' or v_slug = '' then
    raise exception using
      errcode = '22023',
      message = 'Nombre y slug son obligatorios';
  end if;
  -- El número deja de ser obligatorio SOLO para el negocio del marketplace,
  -- que se atiende por el número de la plataforma. Para los demás sigue
  -- siéndolo: sin él, el webhook no tendría forma de saber de quién es el
  -- mensaje que acaba de llegar.
  if v_whatsapp_provider <> 'marketplace' and v_whatsapp_number = '' then
    raise exception using
      errcode = '22023',
      message = 'Un negocio con canal propio necesita su número';
  end if;
  if (v_client_email is null) <> (v_password_hash is null) then
    raise exception using
      errcode = '22023',
      message = 'Email y contraseña deben enviarse juntos';
  end if;
  if v_password_hash is not null
     and v_password_hash !~ '^\$2[aby]\$[0-9]{2}\$' then
    raise exception using
      errcode = '22023',
      message = 'La contraseña debe llegar cifrada';
  end if;
  if v_chat_mode not in ('miniapp') then
    raise exception using
      errcode = '22023',
      message = 'El único modo de conversación es miniapp';
  end if;

  select *
  into v_plan_definition
  from public.billing_plan_definition(v_plan);

  if not found then
    raise exception using
      errcode = '22023',
      message = 'El plan seleccionado no existe';
  end if;

  if p_monthly_rate is not null
     and p_monthly_rate is distinct from v_plan_definition.monthly_rate then
    raise exception using
      errcode = '22023',
      message = 'La tarifa no coincide con el catálogo del plan';
  end if;
  if nullif(p_business ->> 'monthly_contact_limit', '') is not null
     and nullif(p_business ->> 'monthly_contact_limit', '')::integer
       is distinct from v_plan_definition.monthly_contact_limit then
    raise exception using
      errcode = '22023',
      message = 'El límite de contactos no coincide con el catálogo del plan';
  end if;
  if nullif(
    p_business ->> 'monthly_outbound_message_limit',
    ''
  ) is not null
     and nullif(
       p_business ->> 'monthly_outbound_message_limit',
       ''
     )::integer
       is distinct from v_plan_definition.monthly_outbound_message_limit then
    raise exception using
      errcode = '22023',
      message = 'El límite de mensajes no coincide con el catálogo del plan';
  end if;

  v_plan := v_plan_definition.plan_code;
  v_monthly_rate := v_plan_definition.monthly_rate;
  v_contact_limit := v_plan_definition.monthly_contact_limit;
  v_outbound_limit := v_plan_definition.monthly_outbound_message_limit;

  insert into public.businesses (
    slug,
    name,
    type,
    whatsapp_number,
    whatsapp_provider,
    ycloud_api_key,
    ycloud_number,
    ycloud_webhook_endpoint_id,
    ycloud_webhook_secret,
    meta_token,
    meta_phone_id,
    telegram_bot_token,
    takes_orders,
    storefront_enabled,
    chat_mode,
    ai_provider,
    owner_phone,
    plan,
    active,
    bot_active,
    suspended,
    notes,
    monthly_rate,
    monthly_contact_limit,
    monthly_outbound_message_limit,
    prep_time_minutes,
    delivery_extra_minutes
  ) values (
    v_slug,
    v_name,
    coalesce(nullif(p_business ->> 'type', ''), 'negocio'),
    nullif(v_whatsapp_number, ''),
    v_whatsapp_provider,
    nullif(p_business ->> 'ycloud_api_key', ''),
    nullif(p_business ->> 'ycloud_number', ''),
    nullif(btrim(p_business ->> 'ycloud_webhook_endpoint_id'), ''),
    nullif(p_business ->> 'ycloud_webhook_secret', ''),
    nullif(p_business ->> 'meta_token', ''),
    nullif(p_business ->> 'meta_phone_id', ''),
    nullif(p_business ->> 'telegram_bot_token', ''),
    coalesce((p_business ->> 'takes_orders')::boolean, true),
    coalesce((p_business ->> 'storefront_enabled')::boolean, false),
    v_chat_mode,
    nullif(p_business ->> 'ai_provider', ''),
    nullif(p_business ->> 'owner_phone', ''),
    v_plan,
    true,
    true,
    false,
    nullif(p_business ->> 'notes', ''),
    v_monthly_rate,
    v_contact_limit,
    v_outbound_limit,
    -- Sin valor, el defecto de la columna. El servidor manda el del tipo,
    -- pero un alta hecha fuera del panel no puede quedarse sin tiempo.
    coalesce((p_business ->> 'prep_time_minutes')::int, 25),
    coalesce((p_business ->> 'delivery_extra_minutes')::int, 10)
  )
  returning * into v_business;

  insert into public.bot_policies (business_id)
  values (v_business.id);

  insert into public.business_schedule (
    business_id,
    day_of_week,
    open_time,
    close_time,
    slot_duration,
    is_active
  ) values
    (v_business.id, 0, '09:00', '18:00', 60, false),
    (v_business.id, 1, '09:00', '18:00', 60, true),
    (v_business.id, 2, '09:00', '18:00', 60, true),
    (v_business.id, 3, '09:00', '18:00', 60, true),
    (v_business.id, 4, '09:00', '18:00', 60, true),
    (v_business.id, 5, '09:00', '18:00', 60, true),
    (v_business.id, 6, '09:00', '13:00', 60, true)
  on conflict (business_id, day_of_week) do nothing;

  if v_client_email is not null then
    insert into public.client_users (
      business_id,
      email,
      password_hash,
      role
    ) values (
      v_business.id,
      v_client_email,
      v_password_hash,
      'owner'
    );
  end if;

  insert into public.billing (
    business_id,
    amount,
    currency,
    status,
    period_start,
    period_end,
    notes
  ) values (
    v_business.id,
    v_monthly_rate,
    'USD',
    'pending',
    v_period_start,
    v_period_end,
    'Cuota mensual automática'
  );

  return to_jsonb(v_business);
end;
$$;
revoke all on function public.create_business_onboarding(jsonb, text, text, numeric)
  from public, anon, authenticated;
grant execute on function public.create_business_onboarding(jsonb, text, text, numeric)
  to service_role;

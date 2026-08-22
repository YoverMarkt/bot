-- ═══════════════════════════════════════════════════════════════════════════
-- SE RETIRA EL MODO IA
--
-- Decisión del dueño (2026-08-21): todo lo que ve el cliente lo escribe el
-- CÓDIGO, con datos de la base. Nada redactado por un modelo.
--
-- Con ello se fueron `services/prompt.ts`, `services/price-guard.ts`, la rama
-- de IA de `bot-conversation.ts` (206 líneas), la del simulador (74) y el RAG
-- que metía el catálogo en un prompt. Quedan dos modos: `menu` y `miniapp`.
--
-- ⚠️ RADIO DE DAÑO CERO, MEDIDO ANTES: el único negocio en producción está en
-- `miniapp`. Ningún negocio usa `ai`, así que la conversión de más abajo no
-- toca ninguna fila. Se deja igualmente porque una base de pruebas o un
-- despliegue futuro sí podrían tenerla.
--
-- ⚠️ EL ORDEN IMPORTA: primero se convierten los negocios que estén en `ai`,
-- y solo después se estrecha el CHECK. Al revés, el propio `alter` fallaría
-- sobre las filas que intenta arreglar.
--
-- ⚠️ `bot_policies.bot_prompt` NO se toca aquí, y es deliberado: el modo menú
-- lo lee para su mensaje de bienvenida. Convertirlo en un saludo de verdad
-- —en vez de un prompt del que se extrae uno con expresiones regulares— es el
-- paso siguiente y va en su propia migración.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. Los negocios que estuvieran en modo IA pasan a menú ─────────────────
--
-- `menu` y no `miniapp`: el menú atiende por chat con cualquier catálogo,
-- mientras que la mini app exige pedidos Y tienda encendidos. Mandar ahí a un
-- negocio sin tienda le dejaría el bot mudo.
update public.businesses
   set chat_mode = 'menu'
 where chat_mode = 'ai';


-- ── 2. El defecto de la columna deja de ser `ai` ───────────────────────────
--
-- Sin esto, cualquier insert que no nombre `chat_mode` —los hay en las
-- verificaciones y podría haberlos en cualquier script— fallaría contra el
-- CHECK nuevo. Se pone `menu` por lo mismo que arriba.
alter table public.businesses
  alter column chat_mode set default 'menu';


-- ── 3. Los modos válidos pasan a ser dos ───────────────────────────────────
alter table public.businesses
  drop constraint if exists businesses_chat_mode_check;

alter table public.businesses
  add constraint businesses_chat_mode_check
  check (chat_mode in ('menu', 'miniapp'));


-- ── 4. El alta deja de aceptar `ai` ────────────────────────────────────────
--
-- Se parte de la ÚLTIMA versión viva —la de
-- `migration-2026-08-20-negocio-sin-canal-propio.sql`— y se cambian dos cosas:
-- la lista de modos válidos y el valor por defecto, que era `ai`.

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
    coalesce(nullif(btrim(p_business ->> 'chat_mode'), ''), 'menu');
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
  if v_chat_mode not in ('menu', 'miniapp') then
    raise exception using
      errcode = '22023',
      message = 'El modo de conversación debe ser menu o miniapp';
  end if;
  if v_chat_mode = 'miniapp' and (
    coalesce((p_business ->> 'takes_orders')::boolean, true) is not true
    or coalesce((p_business ->> 'storefront_enabled')::boolean, false) is not true
  ) then
    raise exception using
      errcode = '22023',
      message = 'El modo miniapp requiere pedidos y tienda habilitados';
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

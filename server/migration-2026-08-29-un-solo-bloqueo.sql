-- ═══════════════════════════════════════════════════════════════════════════
-- UNA SOLA DEFINICIÓN DE «BLOQUEADO», Y LA MINI APP LA RESPETA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Lo encontró el dueño probando la madrugada del 2026-08-29, y es el agujero
-- más grave que quedaba: **estando bloqueado en Monster Pizza, subió por el
-- chat, tocó un enlace viejo, entró a la tienda y CREÓ el pedido #74.**
--
-- ── POR QUÉ SE COLÓ ────────────────────────────────────────────────────────
--
-- Porque «bloqueado» se responde en DOS sitios con DOS reglas distintas:
--
--   · El CHAT (`isContactBlocked`, en TypeScript) miraba `blocked_at` a secas.
--   · La BASE (`storefront_customer_blocked`, que usa `orders_reject_blocked`)
--     mira la regla completa: permanente = `blocked_at` puesto Y
--     `blocked_until` nulo; temporal = `blocked_until` todavía en el futuro.
--
-- Con un bloqueo temporal YA VENCIDO —`blocked_at` puesto, `blocked_until` en
-- el pasado— las dos respuestas se separan: el chat dice «bloqueado» y la base
-- dice «adelante». Eso es exactamente lo que pasó a las 01:01: el chat le negó
-- el local y el disparador le dejó insertar el pedido.
--
-- ⚠️ Y la grieta corta hacia los DOS lados. En el otro sentido, el bloqueo
-- temporal de 30 minutos **nunca caducaba para el chat**: `blocked_at` se
-- queda puesto para siempre (`coalesce(blocked_at, now())` en
-- `block_customer_temporarily`), así que pasado el plazo la base le deja pedir
-- y el chat le seguiría diciendo que no. Un castigo de media hora convertido
-- en perpetuo sin que nadie lo decidiera.
--
-- ── LA REGLA, EN UN SOLO SITIO ─────────────────────────────────────────────
--
-- `storefront_customer_block_state` pasa a ser la ÚNICA fuente, y
-- `storefront_customer_blocked` se reescribe para llamarla. Así el disparador
-- de pedidos, el chat y la mini app no pueden volver a contestar distinto: no
-- es que estén sincronizados, es que solo hay una respuesta.
--
-- Devuelve el estado entero y no un booleano porque las pantallas necesitan
-- decir HASTA CUÁNDO. «No puedes pedir» sin plazo es el mensaje que hace que
-- la gente escriba al local; «te faltan 12 minutos» no.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.storefront_customer_block_state(
  p_business_id uuid,
  p_customer_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select jsonb_build_object(
        -- Permanente: el del dueño. Se reconoce porque no tiene fin.
        -- Temporal: solo cuenta mientras no haya pasado su hora.
        'blocked',    (bc.blocked_at is not null and bc.blocked_until is null)
                   or (bc.blocked_until is not null and bc.blocked_until > now()),
        'permanent',  bc.blocked_at is not null and bc.blocked_until is null,
        -- Nulo en el permanente: no hay plazo que prometer, y prometer uno que
        -- no se cumple es cómo nació el fallo del número del 2026-08-23.
        'until',      case
                        when bc.blocked_until is not null and bc.blocked_until > now()
                        then bc.blocked_until
                      end
      )
      from public.business_customers as bc
      where bc.business_id = p_business_id
        and bc.customer_id = p_customer_id
    ),
    jsonb_build_object('blocked', false, 'permanent', false, 'until', null)
  );
$$;

comment on function public.storefront_customer_block_state(uuid, uuid) is
  'La ÚNICA respuesta a «¿está bloqueado?». El chat, la mini app y el '
  'disparador de pedidos la comparten para no poder contradecirse.';

revoke all on function public.storefront_customer_block_state(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.storefront_customer_block_state(uuid, uuid)
  to service_role;

-- ── El booleano de siempre, ahora derivado ─────────────────────────────────
--
-- ⚠️ NO se retira: lo usa `orders_reject_blocked`, que es el cinturón dentro
-- de la misma transacción que la inserción. Lo que cambia es que ya no lleva
-- su propia copia de la regla — la lee de la función de arriba.
create or replace function public.storefront_customer_blocked(
  p_business_id uuid,
  p_customer_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (public.storefront_customer_block_state(p_business_id, p_customer_id) ->> 'blocked')::boolean,
    false
  );
$$;

revoke all on function public.storefront_customer_blocked(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.storefront_customer_blocked(uuid, uuid)
  to service_role;

-- ── Comprobación inmediata ─────────────────────────────────────────────────
--
-- Se ejecutan los cuatro estados que la pueden romper, incluido el que se
-- coló de verdad: bloqueo temporal VENCIDO con `blocked_at` todavía puesto.
do $comprobacion$
declare
  v_local   uuid;
  v_cliente uuid;
  v_estado  jsonb;
begin
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders, chat_mode
  ) values (
    'bloqueo-uno-tmp', 'Bloqueo', 'pizzeria', 'ycloud',
    '+593900555001', '+593900555001', true, 'miniapp'
  ) returning id into v_local;

  insert into public.customers (phone) values ('593900555100') returning id into v_cliente;
  insert into public.business_customers (business_id, customer_id)
  values (v_local, v_cliente);

  -- ── 1. Sin bloqueo ───────────────────────────────────────────────────────
  v_estado := public.storefront_customer_block_state(v_local, v_cliente);
  if (v_estado->>'blocked')::boolean then
    raise exception 'un cliente sin bloqueo salió bloqueado: %', v_estado;
  end if;

  -- ── 2. Bloqueo PERMANENTE (el del dueño) ────────────────────────────────
  update public.business_customers set blocked_at = now(), blocked_until = null
   where business_id = v_local and customer_id = v_cliente;
  v_estado := public.storefront_customer_block_state(v_local, v_cliente);
  if not (v_estado->>'blocked')::boolean then
    raise exception 'el bloqueo del dueño no bloqueó: %', v_estado;
  end if;
  if not (v_estado->>'permanent')::boolean then
    raise exception 'el bloqueo del dueño no salió permanente: %', v_estado;
  end if;
  if v_estado->>'until' is not null then
    raise exception 'un bloqueo permanente NO puede prometer plazo: %', v_estado;
  end if;

  -- ── 3. Bloqueo TEMPORAL vigente ─────────────────────────────────────────
  update public.business_customers
     set blocked_at = now(), blocked_until = now() + interval '30 minutes'
   where business_id = v_local and customer_id = v_cliente;
  v_estado := public.storefront_customer_block_state(v_local, v_cliente);
  if not (v_estado->>'blocked')::boolean then
    raise exception 'el bloqueo temporal vigente no bloqueó: %', v_estado;
  end if;
  if (v_estado->>'permanent')::boolean then
    raise exception 'un bloqueo temporal salió como permanente: %', v_estado;
  end if;
  if v_estado->>'until' is null then
    raise exception 'un bloqueo temporal tiene que decir hasta cuándo: %', v_estado;
  end if;

  -- ── 4. EL CASO QUE SE COLÓ: temporal VENCIDO con blocked_at puesto ──────
  --
  -- Aquí el chat decía «bloqueado» y la base «adelante», y por esa grieta
  -- entró el pedido #74. Las dos respuestas tienen que ser la MISMA: ya
  -- cumplió su castigo, puede pedir.
  update public.business_customers
     set blocked_at = now() - interval '2 hours',
         blocked_until = now() - interval '1 hour'
   where business_id = v_local and customer_id = v_cliente;
  v_estado := public.storefront_customer_block_state(v_local, v_cliente);
  if (v_estado->>'blocked')::boolean then
    raise exception 'un bloqueo temporal VENCIDO siguió bloqueando: %', v_estado;
  end if;
  if public.storefront_customer_blocked(v_local, v_cliente) then
    raise exception 'el booleano no coincide con el estado: la grieta sigue abierta';
  end if;

  -- ── 5. Y el booleano SIEMPRE dice lo mismo que el estado ────────────────
  update public.business_customers
     set blocked_at = now(), blocked_until = now() + interval '10 minutes'
   where business_id = v_local and customer_id = v_cliente;
  if public.storefront_customer_blocked(v_local, v_cliente)
     <> (public.storefront_customer_block_state(v_local, v_cliente)->>'blocked')::boolean then
    raise exception 'el booleano y el estado se contradicen';
  end if;

  delete from businesses where id = v_local;
  delete from public.customers where id = v_cliente;
  raise notice 'UN SOLO BLOQUEO: el chat, la mini app y el disparador comparten la regla';
end;
$comprobacion$;

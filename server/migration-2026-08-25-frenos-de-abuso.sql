-- ═══════════════════════════════════════════════════════════════════════════
-- DOS FRENOS QUE FALTABAN: PEDIDOS EN AVALANCHA Y BLOQUEO DE PLATAFORMA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El techo del 2026-08-24 cuenta RESPUESTAS. No cuenta pedidos, y ahí estaba el
-- daño que no se mide en dinero: diez pedidos falsos en cinco minutos son diez
-- alarmas sonando, diez comandas en la cocina y comida preparada que nadie
-- recoge. El bloqueo del dueño solo actúa DESPUÉS, cuando el daño ya está.
--
-- Y bloquear era por local: quien molesta a cinco locales había que bloquearlo
-- cinco veces, cada dueño por su cuenta y sin saber de los demás.

-- ── 1. Nadie deja diez pedidos abiertos ────────────────────────────────────
--
-- ⚠️ VA EN UN DISPARADOR, no dentro de `create_storefront_order`. Es la misma
-- regla que ya siguieron `orders_reject_blocked` y `orders_stamp_pricing`: la
-- función del dinero no se recrea por un añadido, y así el freno cubre TODOS
-- los caminos que creen pedidos, incluidos los que no existen todavía.
--
-- ⚠️ La ventana es imprescindible. Sin ella, tres pedidos abandonados en
-- `esperando_pago` de hace un mes dejarían a ese cliente sin poder volver a
-- pedir NUNCA — y hoy nadie expira los pedidos abandonados (`expirado` está en
-- las restricciones y no lo escribe nadie). Con ventana, el freno estorba seis
-- horas y se suelta solo.
--
-- ⚠️ Solo `source = 'storefront'`, igual que el bloqueo. Un pedido de MOSTRADOR
-- lo teclea el dueño con la persona delante: si quiere meter cinco seguidos,
-- es su cocina y su decisión.
--
-- ⚠️ Cuenta lo que el dueño AÚN NO HA MIRADO. En cuanto acepta —`aceptado`,
-- `preparacion`— ese pedido deja de contar: ya decidió tomarlo, y el cliente
-- puede encargar otra cosa sin que el freno se lo impida.
create or replace function public.orders_limit_open_per_customer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_abiertos integer;
  v_tope constant integer := 3;
  v_ventana constant interval := interval '6 hours';
begin
  if coalesce(new.source, '') <> 'storefront' or new.customer_id is null then
    return new;
  end if;

  select count(*) into v_abiertos
  from public.orders as previo
  where previo.business_id = new.business_id
    and previo.customer_id = new.customer_id
    and previo.source = 'storefront'
    and previo.status in ('esperando_pago', 'pago_en_revision', 'pendiente')
    and previo.created_at > now() - v_ventana;

  if v_abiertos >= v_tope then
    -- El texto lo lee el CLIENTE: dice qué pasa y qué hacer, sin acusar a
    -- nadie. Quien se topa con esto suele ser alguien que reintentó tres veces
    -- porque no le llegaba la confirmación.
    raise exception using
      errcode = '42501',
      message = 'Ya tienes pedidos sin confirmar en este local. Espera a que los revisen antes de hacer otro.';
  end if;

  return new;
end;
$$;

drop trigger if exists orders_limit_open_per_customer on public.orders;
create trigger orders_limit_open_per_customer
  before insert on public.orders
  for each row execute function public.orders_limit_open_per_customer();

-- El disparador cuenta por (negocio, cliente, estado, fecha). Sin este índice
-- serían tres consultas secuenciales sobre `orders` en cada pedido nuevo.
create index if not exists idx_orders_abiertos_por_cliente
  on public.orders (business_id, customer_id, status, created_at)
  where source = 'storefront';


-- ── 2. El bloqueo de PLATAFORMA ────────────────────────────────────────────
--
-- Distinto del bloqueo del dueño, y los dos hacen falta:
--
--   · `business_customers.blocked_at` lo pone EL DUEÑO y vale para SU local.
--     Que El Puerto te expulse no puede dejarte fuera de Umbani entero.
--   · `customers.blocked_at` lo pone el SUPERADMIN y vale para toda la
--     plataforma: el bot no contesta y ningún local acepta el pedido.
--
-- ⚠️ Vive en `customers` y no en `marketplace_conversations` porque es de la
-- PERSONA, no de una conversación: reiniciar el chat no puede levantar un
-- bloqueo, y borrar la conversación tampoco.
alter table public.customers
  add column if not exists blocked_at timestamptz,
  add column if not exists blocked_reason text;

alter table public.customers
  drop constraint if exists customers_blocked_reason_check;
alter table public.customers
  add constraint customers_blocked_reason_check
  check (blocked_reason is null or char_length(btrim(blocked_reason)) between 3 and 200);

-- Se consulta en CADA mensaje al número de la plataforma, así que el índice no
-- es opcional. Parcial: los bloqueados son un puñado entre todos los clientes.
create index if not exists idx_customers_bloqueados
  on public.customers (id) where blocked_at is not null;

-- ⚠️ Disparador APARTE de `orders_reject_blocked`, no una condición más dentro.
-- Son dos decisiones de personas distintas —el dueño y el superadmin— con dos
-- motivos distintos, y mezclarlas haría que el día que una falle nadie sepa
-- cuál de las dos actuó.
--
-- ⚠️ Aquí NO se acota a `storefront`. Un bloqueo de plataforma alcanza también
-- al mostrador: si el superadmin expulsó a alguien de Umbani, un local no puede
-- colarlo tecleándole el pedido a mano.
create or replace function public.orders_reject_platform_blocked()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.customer_id is not null
     and exists (
       select 1 from public.customers
       where id = new.customer_id and blocked_at is not null
     ) then
    raise exception using
      errcode = '42501',
      message = 'No podemos procesar este pedido.';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_reject_platform_blocked on public.orders;
create trigger orders_reject_platform_blocked
  before insert on public.orders
  for each row execute function public.orders_reject_platform_blocked();

/**
 * Bloquea o desbloquea a alguien en TODA la plataforma, por teléfono.
 *
 * ⚠️ Por dígitos, como todo lo que toca teléfonos aquí: el mismo número llega
 * como `+593…` por un canal y `593…` por otro, y dos formas de escribirlo
 * serían dos personas — una bloqueada y la otra no.
 *
 * ⚠️ CREA al cliente si no existía. Quien escribe para molestar puede no haber
 * pedido nunca, y es justo a ese al que hay que poder bloquear antes de que lo
 * intente. Es la misma razón que ya tiene `set_contact_blocked` del dueño.
 */
create or replace function public.set_platform_blocked(
  p_phone  text,
  p_blocked boolean,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_digitos text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_id uuid;
begin
  if char_length(v_digitos) < 8 or char_length(v_digitos) > 15 then
    raise exception using
      errcode = '22023',
      message = 'El teléfono debe tener entre 8 y 15 dígitos';
  end if;

  insert into public.customers (phone) values (v_digitos)
  on conflict (phone) do nothing;

  update public.customers
     set blocked_at = case when p_blocked then now() else null end,
         blocked_reason = case when p_blocked then nullif(btrim(coalesce(p_reason, '')), '') else null end
   where phone = v_digitos
   returning id into v_id;

  return jsonb_build_object('phone', v_digitos, 'blocked', p_blocked, 'customer_id', v_id);
end;
$$;

revoke all on function public.set_platform_blocked(text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.set_platform_blocked(text, boolean, text)
  to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- LA CONVERSACIÓN DEL MARKETPLACE
--
-- Fase 2. Con un solo número, el teléfono ya no dice de qué negocio es un
-- mensaje: lo dice el estado de la conversación. Este es ese estado, y vive en
-- la base porque hoy vive en un `Map` de memoria
-- (`services/bot-menu-flow.ts:465`), que se pierde en cada despliegue y que con
-- dos instancias llevaría dos cuentas distintas del mismo carrito.
--
-- ⚠️ NO LLEVA `business_id`, Y ES DELIBERADO. Es la única tabla del marketplace
-- que no puede llevarlo: la conversación ABARCA varios negocios. Antes de que
-- el cliente elija local no hay ninguno, y el dato central —«¿en qué local está
-- AHORA?»— es mutable, así que es un `selected_business_id` anulable, no una
-- llave de tenant.
--
-- El riesgo que eso abre es concreto: una pizzería no puede llegar a saber que
-- su cliente está pidiendo en la competencia. Se cierra como ya se cierran
-- `customers` y `business_channel_identifiers` —quitando el acceso en vez de
-- partir la tabla—, con el patrón MÁS estricto de los dos: RLS, `revoke all` a
-- todos incluido `service_role`, y después el permiso mínimo. Ninguna ruta de
-- cliente la lee jamás; el panel del negocio sigue viendo `conversation_sessions`,
-- que no se toca. Lo comprueba `tests/sql/verificar-aislamiento.sql`.
--
-- ⚠️ NO se recrean `create_storefront_order` ni `set_order_status`, ni se toca
-- `conversation_sessions`. Esto solo AÑADE.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. La conversación ─────────────────────────────────────────────────────
create table if not exists public.marketplace_conversations (
  id                   uuid primary key default gen_random_uuid(),
  -- Una conversación por cliente, no por negocio: hay UN número para todo.
  customer_id          uuid not null
                       references public.customers(id) on delete cascade,
  current_state        text not null default 'inicio',
  -- Nulo = el cliente aún no eligió local. De ahí se DERIVA que la búsqueda es
  -- global: guardar aparte un `search_scope` daría dos campos que pueden
  -- contradecirse, y habría que decidir cuál miente.
  selected_business_id uuid references public.businesses(id) on delete set null,
  -- Un flujo de compra a la vez: hasta terminar o cancelar, no se empieza otro.
  shopping_locked      boolean not null default false,
  -- Dónde está dentro del menú. Es lo que hoy guarda el `Map`.
  flow_state           jsonb,
  -- Bloqueo optimista: dos mensajes del mismo cliente a la vez no pueden
  -- pisarse. La cola ya los serializa por conversación (`stream_key_hash`),
  -- pero eso no cubre que escriba por WhatsApp y por la mini app a la vez.
  version              integer not null default 1,
  last_message_at      timestamptz not null default now(),
  expires_at           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- Los nombres de estado NO se enumeran todavía a propósito: el flujo del
  -- marketplace se construye en la fase 3, y fijar aquí una lista sería
  -- adivinarla. Se valida el formato, que es lo que sí se sabe hoy.
  constraint marketplace_conversations_state_check check (
    current_state ~ '^[a-z][a-z_]{2,39}$'
  ),
  -- Estar bloqueado en ningún negocio no significa nada. El estado imposible
  -- se prohíbe aquí, no se confía en que nadie lo escriba.
  constraint marketplace_conversations_bloqueo_check check (
    shopping_locked = false or selected_business_id is not null
  ),
  constraint marketplace_conversations_flow_check check (
    flow_state is null
    or (jsonb_typeof(flow_state) = 'object' and pg_column_size(flow_state) <= 65536)
  ),
  constraint marketplace_conversations_version_check check (version >= 1)
);

create unique index if not exists uq_marketplace_conversations_customer
  on public.marketplace_conversations (customer_id);

-- Para la reconciliación: conversaciones abandonadas o vencidas.
create index if not exists idx_marketplace_conversations_actividad
  on public.marketplace_conversations (last_message_at);

-- Para el disparador de borrado y para «¿quién está pidiendo aquí ahora?».
create index if not exists idx_marketplace_conversations_negocio
  on public.marketplace_conversations (selected_business_id)
  where selected_business_id is not null;


-- ── 2. Blindaje ────────────────────────────────────────────────────────────
--
-- El patrón de `business_channel_identifiers`, que es el más estricto que hay
-- en el proyecto: RLS, y además se retira el acceso a TODOS —incluido
-- `service_role`— antes de devolver el mínimo imprescindible. `service_role`
-- salta la RLS, así que sin el `revoke` la RLS no le aplicaría.
alter table public.marketplace_conversations enable row level security;

revoke all on table public.marketplace_conversations
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.marketplace_conversations
  to service_role;


-- ── 3. Si el local desaparece, la conversación se reinicia ─────────────────
--
-- `on delete set null` dejaría un cliente «bloqueado comprando» en un negocio
-- que ya no existe, y eso viola el CHECK de arriba: el borrado del negocio
-- fallaría. Reiniciar la conversación ANTES es lo que de verdad se quiere —el
-- cliente vuelve al menú— y además deja el CHECK siempre cierto.
--
-- Se hace con disparador y no dentro de la ruta que borra, por lo mismo que
-- `orders_reject_blocked`: cubre cualquier camino, hoy y mañana.
create or replace function public.marketplace_conversations_reset_on_business_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.marketplace_conversations
     set selected_business_id = null,
         shopping_locked      = false,
         flow_state           = null,
         current_state        = 'inicio',
         version              = version + 1,
         updated_at           = now()
   where selected_business_id = old.id;
  return old;
end;
$$;

revoke all on function public.marketplace_conversations_reset_on_business_delete()
  from public, anon, authenticated;

drop trigger if exists businesses_reset_marketplace_conversations
  on public.businesses;
create trigger businesses_reset_marketplace_conversations
  before delete on public.businesses
  for each row
  execute function public.marketplace_conversations_reset_on_business_delete();


-- ── 4. Avanzar la conversación, en una sola operación ──────────────────────
--
-- Devuelve la conversación tras aplicar el cambio, o `conflicto: true` si otro
-- proceso la movió mientras tanto. El llamador vuelve a leer y reintenta: es
-- más barato que un lock sostenido y no deja transacciones abiertas esperando.
--
-- ⚠️ `p_expected_version` nulo = «no me importa quién la tocó», y sirve para el
-- primer mensaje. Con versión, la condición viaja DENTRO del `update`: mirarla
-- antes en un `select` aparte deja la carrera abierta entre las dos consultas.
create or replace function public.advance_marketplace_conversation(
  p_customer_id       uuid,
  p_expected_version  integer default null,
  p_state             text default null,
  p_business_id       uuid default null,
  p_clear_business    boolean default false,
  p_shopping_locked   boolean default null,
  p_flow_state        jsonb default null,
  p_clear_flow        boolean default false
)
returns jsonb
language plpgsql
-- ⚠️ `security invoker` (el defecto) A PROPÓSITO, al revés que la mayoría de
-- funciones del proyecto. Aquí no hace falta: quien la llama es `service_role`,
-- que ya tiene permisos sobre la tabla. Y así hay DOS cerrojos en vez de uno —
-- si algún día alguien concediera `execute` por error, la tabla seguiría
-- negando el acceso. En la tabla que guarda en qué local compra cada cliente,
-- ese segundo cerrojo vale la inconsistencia.
set search_path = public, pg_temp
as $$
declare
  v_fila public.marketplace_conversations%rowtype;
begin
  if p_customer_id is null then
    raise exception using
      errcode = '22023',
      message = 'Falta el cliente de la conversación';
  end if;

  -- Nace en el primer mensaje. `on conflict` en vez de comprobar antes: dos
  -- mensajes simultáneos de un cliente nuevo llegarían los dos al insert.
  insert into public.marketplace_conversations (customer_id)
  values (p_customer_id)
  on conflict (customer_id) do nothing;

  update public.marketplace_conversations as conv
     set current_state        = coalesce(p_state, conv.current_state),
         selected_business_id = case
                                  when p_clear_business then null
                                  else coalesce(p_business_id, conv.selected_business_id)
                                end,
         -- Soltar el negocio suelta el bloqueo: quedarse bloqueado en ninguna
         -- parte es justo el estado que el CHECK prohíbe.
         shopping_locked      = case
                                  when p_clear_business then false
                                  else coalesce(p_shopping_locked, conv.shopping_locked)
                                end,
         flow_state           = case
                                  when p_clear_flow then null
                                  else coalesce(p_flow_state, conv.flow_state)
                                end,
         version              = conv.version + 1,
         last_message_at      = now(),
         updated_at           = now()
   where conv.customer_id = p_customer_id
     and (p_expected_version is null or conv.version = p_expected_version)
  returning * into v_fila;

  if v_fila.id is null then
    return jsonb_build_object('conflicto', true);
  end if;

  return to_jsonb(v_fila) || jsonb_build_object('conflicto', false);
end;
$$;

revoke all on function public.advance_marketplace_conversation(
  uuid, integer, text, uuid, boolean, boolean, jsonb, boolean
) from public, anon, authenticated;
grant execute on function public.advance_marketplace_conversation(
  uuid, integer, text, uuid, boolean, boolean, jsonb, boolean
) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- UN CLIENTE BLOQUEADO NO CREA PEDIDOS, Y LO DECIDE LA FUNCIÓN DEL DINERO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El bloqueo se comprobaba SOLO en la ruta (`storefront.routes.ts`), y ahí hay
-- dos agujeros que no se tapan desde fuera:
--
--   1. **Falla abierto.** La consulta lleva `.catch(() => false)`, así que un
--      error de base deja pasar el pedido. Se eligió así para que una caída no
--      tumbara los pedidos de todos los negocios — pero AQUÍ ese dilema no
--      existe: si esta función no corre, no hay pedido de todas formas.
--   2. **Hay carrera.** Entre la comprobación de la ruta y la creación del
--      pedido caben milisegundos, y el dueño puede bloquear justo ahí.
--
-- La comprobación de la ruta NO se retira: sigue dando el 403 con un mensaje
-- claro para la app. Esto es el cinturón, igual que el CHECK de `orders` no
-- sustituye a la validación de la ruta sino que la respalda.
--
-- ⚠️ Y NO se hace recreando `create_storefront_order`. Está escrito en
-- CLAUDE.md por algo: recrear la función del dinero por un añadido pequeño no
-- compensa el riesgo de copiar la versión equivocada desde `schema.sql`, donde
-- convive con una definición anterior. Un TRIGGER sobre `orders` consigue lo
-- mismo sin tocarla, y cubre además cualquier camino que se invente después
-- —el Marketplace, un importador— sin que nadie tenga que acordarse.
--
-- ⚠️ Acotado a `source = 'storefront'`. Un pedido de MOSTRADOR lo teclea el
-- dueño con la persona delante: si decide venderle a alguien a quien bloqueó
-- en el chat, es asunto suyo. Bloquear significa «no me escribas ni me pidas
-- por la app», no «no me compres nunca».
--
-- ⚠️ El mensaje no dice «estás bloqueado». Quien molesta busca una reacción, y
-- el dueño no tiene por qué dar explicaciones desde una pantalla.
--
-- ⚠️ Sin `begin`/`commit`: la transacción la abre el ejecutor
-- (`tests/migraciones.mjs`). Lo vigila `migraciones-guardian.test.js`.

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
  select exists (
    select 1
    from public.business_customers
    where business_id = p_business_id
      and customer_id = p_customer_id
      and blocked_at is not null
  );
$$;

revoke all on function public.storefront_customer_blocked(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.storefront_customer_blocked(uuid, uuid)
  to service_role;

-- ── El cinturón ────────────────────────────────────────────────────────────
--
-- Va dentro de la MISMA transacción que la inserción, así que cierra también
-- la carrera: entre la comprobación de la ruta y el `insert` caben
-- milisegundos, y el dueño puede bloquear justo ahí.
create or replace function public.orders_reject_blocked()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(new.source, '') = 'storefront'
     and new.customer_id is not null
     and public.storefront_customer_blocked(new.business_id, new.customer_id) then
    raise exception using
      errcode = '42501',
      message = 'No podemos recibir tu pedido. Comunicate con el local.';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_reject_blocked on public.orders;
create trigger orders_reject_blocked
  before insert on public.orders
  for each row execute function public.orders_reject_blocked();

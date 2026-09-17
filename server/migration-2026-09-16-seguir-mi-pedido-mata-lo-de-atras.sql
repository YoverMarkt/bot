-- ═══════════════════════════════════════════════════════════════════════════
-- «SEGUIR MI PEDIDO» MATA TODO LO DE ATRÁS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Decisión del dueño (2026-09-16): «cuando se coloque MENÚ, o si se estaba
-- haciendo el pedido pero el cliente lo dejó y selecciona continuar con un
-- pedido, que pase igual: todo lo de atrás no funcione».
--
-- MENÚ ya lo cumplía desde el 2026-09-03. «Seguir mi pedido» NO: emite el
-- enlace con `revoke_other_storefront_sessions`, que perdona TODAS las sesiones
-- del MISMO local —para no vaciar un carrito que vive en memoria—. Así que tras
-- «seguir», el enlace viejo de ese local seguía abriendo la tienda.
--
-- ⚠️ POR QUÉ ESA EXCEPCIÓN SOBRA AQUÍ, y no en general. El navegador interno de
-- WhatsApp se cierra al volver al chat, y el carrito se pierde con él. Cuando
-- alguien está ESCRIBIENDO «seguir mi pedido», su carrito ya no existe: la
-- excepción protege algo que ya se fue. Al elegir un local desde el menú sí
-- puede tener sentido, así que `revoke_other_storefront_sessions` no se toca.
--
-- ⚠️ Es una función NUEVA con otro nombre, y no un parámetro más en la vieja.
-- `create or replace function` con un parámetro nuevo NO reemplaza: crea una
-- SEGUNDA función con el mismo nombre, y los `grant` de la firma vieja dejan de
-- valer (VERIFICACION.md, «Guardián de funciones sin dueño»).
--
-- ⚠️ Lo que NO cede, igual que en la vieja: el local donde queda un pedido en
-- `esperando_pago`. Los datos bancarios y la captura del pago viven detrás de
-- esa sesión, y el camino del dinero no se corta nunca.
--
-- Lo que NO toca: `revoke_other_storefront_sessions`, MENÚ, la emisión de
-- enlaces al elegir local, ni ninguna tabla.

create or replace function public.revoke_storefront_sessions_except(
  p_customer_id     uuid,
  p_keep_session_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_revocadas integer;
begin
  if p_customer_id is null or p_keep_session_id is null then
    return 0;
  end if;

  -- Falla hacia NO revocar: si la sesión que hay que conservar no existe, no
  -- se toca nada. Revocar de más deja a un cliente legítimo sin ningún enlace;
  -- un enlace viejo vivo un rato más es recuperable.
  if not exists (
    select 1 from public.storefront_sessions
     where id = p_keep_session_id
       and customer_id = p_customer_id
  ) then
    return 0;
  end if;

  with revocadas as (
    update public.storefront_sessions as sesion
       set revoked_at = now()
     where sesion.customer_id = p_customer_id
       and sesion.revoked_at is null
       and sesion.id <> p_keep_session_id
       -- ⚠️ Aquí la vieja añadía `and sesion.business_id <> v_local_vigente`.
       -- Quitarlo es la diferencia entera: el enlace viejo del MISMO local cae.
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

comment on function public.revoke_storefront_sessions_except(uuid, uuid) is
  'Deja vivo SOLO el enlace indicado, incluso dentro del mismo local. Conserva '
  'el de cualquier local donde quede un pedido en esperando_pago.';

revoke all on function public.revoke_storefront_sessions_except(uuid, uuid)
  from public, anon, authenticated;

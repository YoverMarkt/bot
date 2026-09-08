-- ═══════════════════════════════════════════════════════════════════════════
-- EL BLOQUEADO NO RECIBE UNA PUERTA QUE NO EXISTE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `orders_reject_blocked` rechazaba con:
--
--     «No podemos recibir tu pedido. Comunicate con el local.»
--
-- Y ese mensaje LLEGA AL CLIENTE: la ruta de la tienda y el checkout del chat
-- relanzan el `42501` precisamente para poder explicarle por qué se le rechazó
-- (ver `marketplace-entry.ts`, «el motivo se conserva cuando la BASE lo rechazó
-- por una regla que el cliente PUEDE resolver»).
--
-- ⚠️ El problema es que le ofrece una salida que NO existe. En Umbani el
-- cliente habla con UN solo número —el de la plataforma— y por detrás cada
-- mensaje se enruta a su local: nunca tiene el número de un negocio, ni debe
-- tenerlo. Decisión del dueño, 2026-09-07: «todo tiene que pasar por Umbani,
-- todo; chat, menú, mini app, absolutamente todo; nada por el local del dueño».
-- Mandarlo a «comunicarse con el local» lo deja buscando algo que no está.
--
-- ⚠️ Y tampoco se le dice que faltó a las políticas de Umbani, aunque suene
-- más rotundo: este bloqueo lo pone EL DUEÑO del local y es de SU local — el
-- cliente puede seguir pidiendo en los demás. Echarle la culpa a la plataforma
-- sería acusarle de algo que no hizo. El bloqueo de plataforma es otro
-- (`customers.blocked_at`, disparador `orders_reject_platform_blocked`) y ese
-- ni siquiera contesta.
--
-- Se dice el hecho y nada más. La salida real —los otros locales, con sus
-- botones— la ofrecen el chat y la pantalla de bloqueado de la mini app.
--
-- ⚠️ Solo cambia el TEXTO. La condición, el `errcode` y el disparador se
-- recrean idénticos: quien lea este archivo dentro de un año tiene que poder
-- comprobar de un vistazo que aquí no se tocó a quién se rechaza.

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
      message = 'Este local no esta recibiendo tus pedidos ahora mismo.';
  end if;
  return new;
end;
$$;

-- El disparador se recrea porque `create or replace function` no lo toca, pero
-- dejarlo escrito aquí es lo que permite aplicar este archivo sobre una base
-- que viniera de un punto anterior.
drop trigger if exists orders_reject_blocked on public.orders;
create trigger orders_reject_blocked
  before insert on public.orders
  for each row execute function public.orders_reject_blocked();

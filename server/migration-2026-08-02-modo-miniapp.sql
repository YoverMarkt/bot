-- ═══════════════════════════════════════════════════════════════════════════
-- TRES MODOS DE ATENCIÓN — IA, MENÚ y MINI APP
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El problema que cierra: `chat_mode` solo tenía 'menu' y 'ai', y el enlace de
-- la mini app se mandaba en LOS DOS. Un hostal recién creado recibía el menú
-- de botones Y el enlace a la vez, que son dos formas distintas de hacer lo
-- mismo compitiendo en el mismo chat.
--
-- A partir de aquí cada negocio atiende de UNA forma, y el enlace pertenece a
-- un modo concreto:
--
--   · ai       → conversa con IA. Se pide por chat. SIN enlace.
--   · menu     → botones de código, sin IA. Se pide por el menú. SIN enlace.
--   · miniapp  → la IA responde dudas y el enlace es el sitio donde se pide.
--
-- El modo se propone según el tipo al dar de alta, pero manda siempre lo que
-- decida el negocio: una pizzería que quiera «solo chat» puede quedarse en
-- 'ai' o en 'menu' aunque tenga tienda.
--
-- Idempotente. Aplicar con `npm run migrate`.

alter table public.businesses drop constraint if exists businesses_chat_mode_check;
alter table public.businesses
  add constraint businesses_chat_mode_check check (chat_mode in ('menu', 'ai', 'miniapp'));

-- Los negocios que YA tienen tienda encendida pasan a modo mini app: es el
-- estado en el que deberían haber estado desde el principio, y es justo el
-- caso que hoy recibe menú y enlace a la vez.
update public.businesses
set chat_mode = 'miniapp'
where storefront_enabled = true
  and chat_mode in ('menu', 'ai');

-- ============================================================
-- Cómo se pide lo decide el TIPO de local, no cuántos productos tiene
-- ============================================================
--
-- ⚠️ Corrección del dueño, 2026-08-23, y es la que manda:
--
--   «una pizzería puede tener 10 productos pero al momento de elegir tiene
--    muchas opciones, así como una heladería puede tener 10 helados pero
--    muchos sabores: eso son mini app. Pero un restaurante que ofrece
--    almuerzos solo, queda pedir por WhatsApp.»
--
-- Hasta hoy el marketplace decidía contando PRODUCTOS (la «regla de los 20»,
-- 2026-08-21): hasta 20 se pedía en el chat, por encima se mandaba el enlace.
-- Con ese criterio Monster Pizza —17 productos— caía en el chat, y pedir una
-- pizza por lista de WhatsApp es tamaño, masa, borde y dos sabores: penoso.
--
-- ⚠️ EL CRITERIO CORRECTO YA EXISTÍA Y NO ESTABA CONECTADO. `PEDIDO_SIMPLE`
-- en `apps/admin/src/features/clients/business-types.ts` clasifica exactamente
-- así desde el 2026-08-22 —con los mismos ejemplos de la pizzería y la
-- heladería— pero vive SOLO en el panel del admin, donde el servidor no puede
-- leerlo, y su propio comentario decía que la regla de los 20 lo sobrescribía.
--
-- Por eso el criterio se muda aquí: a la tabla que ya reparte los tipos en
-- categorías. Una sola fuente para el panel y para el servidor, y el
-- superadmin puede reclasificar un tipo sin desplegar — que hace falta,
-- porque la clasificación buena se descubre viendo pedidos reales.

alter table public.marketplace_category_types
  add column if not exists pide_en_chat boolean not null default false;

comment on column public.marketplace_category_types.pide_en_chat is
  'Si el pedido se arma DENTRO del chat (true) o se manda el enlace de la '
  'tienda (false). Lo decide cuánto hay que ELEGIR para armar el pedido, no '
  'cuántos productos hay en el catálogo.';

-- ⚠️ El defecto es FALSE —el enlace— y eso es fallar hacia lo seguro: la
-- tienda atiende cualquier catálogo y cualquier cantidad de opciones,
-- mientras que un menú de chat mal elegido deja al cliente recorriendo listas
-- interminables. Un tipo nuevo cae solo en el lado que siempre funciona.
--
-- Se listan los del CHAT, que son la excepción. Es la misma lista de
-- `PEDIDO_SIMPLE`, y `tipos-que-piden-en-el-chat.test.js` comprueba que las
-- dos no se separen.
update public.marketplace_category_types
   set pide_en_chat = true
 where business_type in (
   -- Platos del día: se elige uno de tres o cuatro.
   'almuerzos', 'menú ejecutivo', 'desayunos', 'comida típica',
   -- Carta corta de platos que se piden por su nombre.
   'marisquería', 'pollo asado', 'asadero', 'parrillada', 'comida saludable',
   -- Producto suelto, sin nada que configurar.
   'postres', 'carnicería', 'cafetería', 'jugos', 'batidos',
   'emprendimiento de comida'
 );

-- Lo que el servidor pregunta al entregar el local: ¿este tipo se pide
-- hablando, o se le manda el enlace?
--
-- ⚠️ Un tipo que no esté en la tabla devuelve FALSE, no error: los negocios
-- con un tipo escrito a mano —`businesses.type` es texto libre— tienen que
-- poder pedir igual, y el enlace es el lado que siempre funciona.
create or replace function public.tipo_pide_en_chat(p_business_type text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select t.pide_en_chat
      from public.marketplace_category_types t
      where t.business_type = btrim(lower(coalesce(p_business_type, '')))
    ),
    false
  );
$$;

revoke all on function public.tipo_pide_en_chat(text) from public, anon, authenticated;
grant execute on function public.tipo_pide_en_chat(text) to service_role;

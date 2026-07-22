-- ============================================================
-- MODO DE CONVERSACIÓN POR NEGOCIO + REPETIR ÚLTIMO PEDIDO
-- Correr en Supabase → SQL Editor. Idempotente: se puede repetir.
-- ============================================================
-- Contexto (decisión 2026-07-22):
--   'menu' → el CÓDIGO conduce la conversación con opciones generadas de los
--            datos reales del negocio. La IA no participa. Precisión total en
--            precios y montos.
--   'ai'   → conversación con IA (comportamiento histórico). El dinero sigue
--            calculándose server-side con money.ts; la IA nunca inventa totales.
--
-- El default es 'ai' A PROPÓSITO: los negocios que ya existen NO cambian de
-- comportamiento al aplicar esta migración. El modo menú se activa a mano
-- desde el panel (o por sugerencia del tipo al crear un negocio nuevo).
-- ============================================================

alter table businesses
  add column if not exists chat_mode text not null default 'ai';

-- La restricción se agrega aparte para poder repetir la migración sin error.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'businesses_chat_mode_check'
  ) then
    alter table businesses
      add constraint businesses_chat_mode_check
      check (chat_mode in ('menu', 'ai'));
  end if;
end $$;

comment on column businesses.chat_mode is
  'Quién conduce la conversación: menu = máquina de estados por código (sin IA); ai = conversación con IA.';

-- ============================================================
-- REPETIR ÚLTIMO PEDIDO
-- ============================================================
-- Buscar el último pedido de un contacto dentro de SU negocio:
--   where business_id = $1 and contact_phone = $2 order by created_at desc limit 1
-- El índice existente (business_id, contact_phone) no ordena por fecha, así que
-- este compuesto evita ordenar en memoria cuando un cliente tiene historial largo.
create index if not exists idx_orders_biz_phone_fecha
  on orders (business_id, contact_phone, created_at desc);

-- Los ítems del pedido se leen por order_id; el índice por negocio ya existe,
-- pero este acelera la lectura de los ítems de un pedido puntual.
create index if not exists idx_order_items_order
  on order_items (order_id);

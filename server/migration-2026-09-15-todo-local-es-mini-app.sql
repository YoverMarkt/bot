-- ═══════════════════════════════════════════════════════════════════════════
-- TODO LOCAL PIDE POR SU MINI APP
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Decisión del dueño (2026-09-14), después de probar el chat con un pedido de
-- verdad: «la experiencia es mala — un pedido familiar cuesta ~14 mensajes de
-- ida y vuelta, y cada saliente se paga». A eso se suma lo que WhatsApp no deja
-- hacer: los títulos de lista se cortan a 24 caracteres y los grupos de casillas
-- no se pueden expresar. Eran DOS motores para lo mismo, y esa duplicidad ya
-- costó un fallo de cuatro días que dejó al chat sin poder vender (#343).
--
-- Lo que SIGUE por WhatsApp, igual que hoy: la bienvenida, las categorías,
-- elegir local, el enlace de la mini app, los comprobantes, los avisos de estado
-- del pedido, la ubicación y MENÚ. Lo único que desaparece es ARMAR EL CARRITO
-- por chat.
--
-- ⚠️ EL ORDEN IMPORTA y ya se cumplió: La Abuelita —el único local que pedía por
-- chat— se pasó a la mini app el 2026-09-15 cambiando `pide_en_chat` a false, y
-- se comprobó vendiendo antes de retirar una sola línea de código.

-- ── 1. La función que decidía el camino ───────────────────────────────────
--
-- Ya no la llama nadie: el camino es uno solo. Una función que existe y nadie
-- usa es código muerto que alguien puede invocar por error años después, y hay
-- un guardián (`funciones-huerfanas`) que lo exige.
drop function if exists public.tipo_pide_en_chat(text);

-- ── 2. La columna que la alimentaba ───────────────────────────────────────
--
-- `marketplace_category_types` SE QUEDA: es el reparto de tipos en categorías,
-- que es lo que arma el menú del marketplace. Lo que se va es la bandera que
-- decidía chat o enlace, porque ya no hay dos caminos que elegir.
--
-- ⚠️ Su contenido no se pierde: los 15 tipos que la tenían en `true` están
-- escritos en `migration-2026-08-23-pedir-por-tipo.sql`, que es de donde
-- salieron.
alter table public.marketplace_category_types
  drop column if exists pide_en_chat;

-- ── 3. Quien estaba a media compra POR CHAT ───────────────────────────────
--
-- Al aplicar esto había UNA conversación en `pidiendo`. Su carrito vivía en
-- `flow_state.menu` y lo armaba un motor que ya no existe, así que se la trata
-- como a quien tiene su enlace abierto: `en_local`, sin carrito y con su local
-- y su candado intactos. El siguiente mensaje le recuerda dónde está y le
-- devuelve su enlace; MENÚ sigue siendo la salida.
--
-- ⚠️ El candado NO se suelta aquí. Soltarlo dejaría a esa persona empezando otro
-- pedido en otro local con el anterior a medias, que es justo lo que ese candado
-- existe para impedir.
update public.marketplace_conversations
   set current_state = 'en_local',
       flow_state = case
         when flow_state ? 'vista' then jsonb_build_object('vista', flow_state -> 'vista')
         else '{}'::jsonb
       end,
       updated_at = now()
 where current_state in (
   'pidiendo', 'esperando_entrega', 'esperando_ubicacion', 'esperando_metodo_pago'
 );

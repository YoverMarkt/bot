-- ============================================================================
-- LA CAPTURA SE MANDA POR EL MISMO CHAT, NO «POR EL CHAT DEL LOCAL»
--
-- En el repaso de todas las pantallas de la mini app (2026-09-25) el checkout
-- decía, debajo de «Transferencia bancaria»: «Transfiere y manda la captura
-- por el chat del local». Con el marketplace el cliente no tiene chat con el
-- local: todo pasa por el número de Umbani, y ningún número del local llega
-- nunca a un cliente. El texto le mandaba a buscar un chat que no existe.
--
-- «El mismo chat de WhatsApp» es verdad en los dos casos —el local con canal
-- propio y el del marketplace—: es donde el cliente recibió su enlace.
--
-- ⚠️ Solo si sigue diciendo lo de antes: si alguien ya lo cambió a mano, no se
-- pisa. Y `schema.sql` siembra ya el texto nuevo para las bases que nacen.
-- ============================================================================

update public.payment_methods
set help_text = 'Transfiere y manda la captura por el mismo chat de WhatsApp.'
where code = 'transferencia'
  and help_text = 'Transfiere y manda la captura por el chat del local.';

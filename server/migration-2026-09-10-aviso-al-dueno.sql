-- ═══════════════════════════════════════════════════════════════════════════
-- EL AVISO DE PEDIDO NUEVO AL WHATSAPP DEL DUEÑO — APAGADO POR DEFECTO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hoy el dueño se entera de un pedido nuevo por la ALARMA de su panel, que es
-- gratis y funciona. Este interruptor añade un aviso por WhatsApp con el
-- resumen del pedido y —si es a domicilio— la ubicación del cliente.
--
-- ⚠️ NACE EN `false`, y esa es la decisión. Desde el 1 de octubre de 2026 Meta
-- cobra cada mensaje saliente: encenderlo son DOS mensajes más por pedido (el
-- resumen y el mapa), por local y todos los días. Con cincuenta pedidos
-- diarios son cien mensajes que hoy no se pagan.
--
-- Un interruptor que nace encendido convierte una mejora en una factura que
-- nadie decidió. Que lo encienda quien paga, local por local, viendo lo que
-- cuesta — y que pueda apagarlo el día que le sobre.
--
-- ⚠️ Es POR LOCAL y no global: un almuerzo con dos pedidos al día lo quiere
-- encendido; una pizzería con cincuenta, seguramente no. Una sola decisión
-- para todos obligaría al que menos pedidos tiene a renunciar a lo que le
-- sirve, o al que más a pagar lo que no necesita.
--
-- ⚠️ Requiere `owner_phone`: sin número no hay a dónde mandarlo. No se fuerza
-- aquí con un CHECK porque el campo se rellena en el alta y el interruptor se
-- toca después; el servidor lo comprueba antes de enviar y no gasta nada si
-- falta.

alter table public.businesses
  add column if not exists notify_owner_whatsapp boolean not null default false;

comment on column public.businesses.notify_owner_whatsapp is
  'Si el dueño recibe por WhatsApp el aviso de pedido nuevo (resumen + '
  'ubicación del cliente). APAGADO por defecto: son dos mensajes pagados por '
  'pedido, y la alarma del panel ya avisa gratis. Lo enciende el dueño.';

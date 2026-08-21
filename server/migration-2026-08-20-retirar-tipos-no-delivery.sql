-- ═══════════════════════════════════════════════════════════════════════════
-- FASE 5 — SOLO COMIDA Y RETAIL
--
-- Umbani reparte pedidos a domicilio. Los tipos de hospedaje, servicios y
-- salud/belleza sobraban del producto anterior: el desplegable del alta seguía
-- ofreciendo hotel, barbería o clínica, negocios a los que esta plataforma no
-- les sirve de nada desde que salieron las citas (fase 2) y el hospedaje
-- (fase 1).
--
-- ⚠️ RADIO DE DAÑO CERO, MEDIDO CONTRA PRODUCCIÓN ANTES DE ESCRIBIR ESTO:
--   · Un solo negocio existe (Monster Pizza, `pizzería`, familia `comida`).
--     NINGÚN negocio usa uno de los tipos que se retiran.
--   · `businesses.type` es texto libre —sin CHECK y sin foránea a
--     `business_type_families`—, así que borrar un mapeo no puede huerfanar
--     una fila de negocio. Solo cambia de qué regla de margen hereda.
--   · No existe ninguna regla con `scope='family'`.
--   · Ningún pedido congeló una regla de familia o de tipo.
--
-- Por eso esto se puede aplicar sin ventana: no toca datos de nadie.
--
-- ⚠️ EL ORDEN IMPORTA. `business_type_families.family_code` referencia a
-- `business_families(code)` **on delete restrict**: si se intentara borrar la
-- familia antes que sus tipos, PostgreSQL lo rechazaría. Primero los mapeos,
-- después las familias.
--
-- ⚠️ NO se recrea ninguna función del dinero. Esto son borrados de filas de
-- catálogo; `calculate_platform_markup` se queda como está y sigue fallando
-- ABIERTO: un tipo sin familia no revienta, solo cae a la regla global.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. Las reglas de margen que apuntaban a lo que se va ───────────────────
--
-- Hoy no hay ninguna, pero `pricing_rules.target_name` es texto suelto sin
-- foránea, así que borrar la familia no arrastra su regla: quedaría activa,
-- visible en el panel y sin poder casar jamás con un negocio. Se archivan en
-- vez de borrarse porque un pedido pudo congelarlas (`orders.pricing_rule_id`)
-- y esa fila tiene que seguir existiendo para explicar lo que ya se cobró.
-- `updated_at` se escribe a mano porque no hay trigger que lo haga, y así el
-- rastro coincide con el que deja `archivePricingRule` desde el panel.
update public.pricing_rules
   set status = 'archived', updated_at = now()
 where status = 'active'
   and (
     (scope = 'family' and target_name in ('hospedaje', 'servicios', 'salud_belleza'))
     or (scope = 'business_type' and target_name in (
       'hotel', 'hostal', 'alojamiento', 'complejo turístico', 'resort', 'cabañas',
       'inmobiliaria', 'taller automotriz', 'servicios profesionales', 'gimnasio',
       'barbería', 'peluquería', 'salón de belleza', 'spa', 'centro de estética',
       'clínica', 'consultorio', 'odontología', 'psicología', 'fisioterapia',
       'masajes'
     ))
   );


-- ── 2. Los tipos que dejan de existir ──────────────────────────────────────
--
-- Son 21: los seis de hospedaje, los once de salud y belleza, y cuatro de
-- servicios. `gimnasio` colgaba de `servicios` y `spa` de `salud_belleza`,
-- pero los dos se van por lo mismo: no se reparten a domicilio.
delete from public.business_type_families
 where business_type in (
   'hotel', 'hostal', 'alojamiento', 'complejo turístico', 'resort', 'cabañas',
   'inmobiliaria', 'taller automotriz', 'servicios profesionales', 'gimnasio',
   'barbería', 'peluquería', 'salón de belleza', 'spa', 'centro de estética',
   'clínica', 'consultorio', 'odontología', 'psicología', 'fisioterapia',
   'masajes'
 );


-- ── 3. `negocio` se queda en el desplegable, pero sin familia ──────────────
--
-- «Otro / negocio genérico» sigue siendo útil al dar de alta algo que no encaja
-- en ninguna casilla, así que NO se retira del panel. Lo que se retira es su
-- mapeo a `servicios`, que era la familia que desaparece.
--
-- Deliberadamente no se remapea a `retail`: un tipo genérico no puede heredar
-- el margen de las tiendas sin que nadie lo haya decidido. Sin familia cae a la
-- regla global, que es exactamente lo que significa «no sé qué es esto».
delete from public.business_type_families
 where business_type = 'negocio';


-- ── 4. Las tres familias vacías ────────────────────────────────────────────
--
-- Quedan `comida` y `retail`. Las otras tres se borran en vez de dejarse
-- vacías porque el desplegable de Finanzas sale de esta tabla
-- (`GET /api/admin/business-families`): dejarlas ofrecería al superadmin
-- crear una regla para «Hospedaje» que no podría alcanzar a ningún negocio.
--
-- El `on delete restrict` del paso 2 es aquí la red: si alguien añadiera un
-- tipo nuevo a una de estas familias entre el paso 2 y este, esto fallaría en
-- vez de dejar el mapeo apuntando al vacío.
delete from public.business_families
 where code in ('hospedaje', 'servicios', 'salud_belleza');

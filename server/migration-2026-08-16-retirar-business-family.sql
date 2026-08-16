-- ═══════════════════════════════════════════════════════════════════════════
-- SE RETIRA `business_family`: NO LA LLAMA NADIE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La creé «para el panel» junto con las familias, y el panel acabó no
-- necesitándola: elige la familia de un desplegable, no la deduce de un
-- negocio. Es código especulativo, y lo cazó `funciones-huerfanas.test.js` —
-- el guardián que existe justo para esto.
--
-- La resolución de reglas por familia NO la usa: hace el `join` con
-- `business_type_families` directamente dentro de `calculate_platform_markup`,
-- que es donde tiene que estar.
--
-- Se retira con un archivo NUEVO y no editando el aplicado: la huella ya está
-- registrada. El día que un panel necesite «¿de qué familia es este negocio?»,
-- son cinco líneas.
--
-- ⚠️ Sin `begin`/`commit`: la transacción la abre el ejecutor.

drop function if exists public.business_family(uuid);

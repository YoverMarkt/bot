-- ============================================================================
-- ARREGLO: no se podía dar de alta NINGÚN cliente nuevo
--
-- Síntoma: crear un negocio desde el panel devolvía «No se pudo crear el
-- cliente» (500) sin más explicación, y nada aparecía en el registro de
-- errores. Descubierto el 2026-08-02 al intentar dar de alta el primer
-- cliente de pago.
--
-- Causa: el disparador `billing_claim_month` estaba declarado BEFORE INSERT
-- sobre `billing`. Al insertar la primera cuota, el disparador metía una fila
-- en `billing_month_claims` apuntando con `billing_id` a una fila de `billing`
-- que TODAVÍA NO EXISTÍA —el BEFORE corre antes de la escritura—, así que la
-- clave foránea `billing_month_claims_billing_id_fkey` reventaba y tumbaba
-- toda la transacción de alta.
--
--   ERROR: insert or update on table "billing_month_claims" violates foreign
--          key constraint "billing_month_claims_billing_id_fkey"
--   DETAIL: Key (billing_id)=(...) is not present in table "billing".
--
-- Arreglo: el mismo disparador, pero AFTER. La fila de `billing` ya existe
-- cuando se reclama el mes, así que la clave foránea encuentra su destino. La
-- protección no se debilita: si el mes ya estaba reclamado, la excepción sigue
-- abortando la transacción igual que antes.
--
-- Por qué no lo detectó nada: la verificación contra PostgreSQL real ejecuta
-- las funciones críticas, pero `create_business_onboarding` NO estaba entre
-- ellas — precisamente la que da de alta a los clientes que pagan. Se añade en
-- el mismo cambio (`server/tests/sql/verificar-esquema.sql`).
--
-- Es idempotente: correrlo dos veces no rompe nada.
-- ============================================================================

drop trigger if exists billing_claim_month on public.billing;

create trigger billing_claim_month
after insert or update of business_id, period_start on public.billing
for each row execute function public.claim_billing_month();

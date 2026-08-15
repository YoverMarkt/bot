-- ═══════════════════════════════════════════════════════════════════════════
-- UN AJUSTE NO PUEDE APUNTAR A LA FACTURA DE OTRO NEGOCIO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `billing_adjustments.billing_id` referenciaba `billing(id)` a secas. Con esa
-- foránea, nada impedía que el ajuste de un comercio se colgara de la factura
-- de OTRO: el descuento de una venta anulada en el local A podía acabar
-- restando en la factura del local B.
--
-- Lo cazó `verificar-fronteras.sql`, el guardián de fronteras multi-tenant que
-- corre en el CI. No lo destapó una prueba de comportamiento —las siete que
-- escribí pasaban— sino el guardián que busca justo esto: una tabla con
-- `business_id` que puede apuntar a la fila de otro negocio.
--
-- Se cierra con foránea COMPUESTA sobre `(id, business_id)`, el mismo patrón
-- que ya usan `product_variants` y los grupos de opciones. Con ella, apuntar a
-- la factura de otro negocio deja de ser un error de programación posible: es
-- imposible a nivel de base.
--
-- ⚠️ Sin `begin`/`commit`: la transacción la abre el ejecutor.

-- La compuesta necesita un índice único sobre las dos columnas del destino.
-- No es redundante con la clave primaria: PostgreSQL exige exactamente esta
-- pareja para poder referenciarla.
create unique index if not exists uq_billing_id_negocio
  on public.billing (id, business_id);

alter table public.billing_adjustments
  drop constraint if exists billing_adjustments_billing_id_fkey;

alter table public.billing_adjustments
  add constraint billing_adjustments_billing_fkey
  foreign key (billing_id, business_id)
  references public.billing (id, business_id)
  on delete set null;

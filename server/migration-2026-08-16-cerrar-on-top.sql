-- ═══════════════════════════════════════════════════════════════════════════
-- `on_top` SE CIERRA: EL PRECIO DEL CLIENTE NO SUBE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La migración anterior abrió `markup_mode = 'on_top'` para poder construirlo.
-- El dueño de la plataforma lo descartó el mismo día, y con dos razones que
-- conviene dejar escritas porque cierran el debate:
--
--   · «Lo que está en la app no tiene que subir de valor» — el margen no puede
--     ir metido en el precio de cada producto.
--   · «El cliente se quejaría» — tampoco como tarifa de servicio visible.
--
-- El modelo es `absorbed`: **el comercio paga la comisión de su precio**, como
-- hacen todas las plataformas grandes. Si quiere compensarla, sube su precio
-- en la app — decisión suya, no de la plataforma.
--
-- ── POR QUÉ ESTO ES URGENTE Y NO COSMÉTICO ────────────────────────────────
--
-- Con el CHECK abierto, un superadmin podía crear una regla `on_top` y el
-- catálogo **seguía sirviendo los precios sin margen**: la tienda mostraría
-- $10.00 y el pedido cobraría $10.80. Es exactamente «el cliente ve un número
-- y paga otro», la regla inviolable #8.
--
-- El disparador ya sabe aplicar `on_top` correctamente; lo que falta es que el
-- catálogo pinte los precios con margen. Mientras eso no exista, activarlo
-- sería mentir, así que **falla CERRADO** — igual que `scope` con 'category'.
--
-- ── LO QUE NO SE BORRA, Y POR QUÉ ─────────────────────────────────────────
--
-- `order_markup_by_line` se queda. No la llama nadie con el CHECK cerrado,
-- pero es el cálculo que evita el céntimo de divergencia —tres empanadas a
-- $3.33 al 8 % son $10.80 producto a producto y $10.79 sobre el subtotal— y
-- está verificado. Borrarla obligaría a rededucirla el día que se retome.
--
-- Tampoco se toca el disparador: su rama de `on_top` es inalcanzable mientras
-- el CHECK no la admita, y quitarla solo añadiría un cambio más al camino por
-- donde pasa cada pedido.
--
-- ⚠️ Se hace con un archivo NUEVO y no editando el aplicado: la huella de la
-- migración ya está registrada, y tocarla dejaría la base diciendo una cosa y
-- el archivo otra. Lo vigila `npm run migrate:status`.
--
-- ⚠️ Sin `begin`/`commit`: la transacción la abre el ejecutor.

-- Ninguna regla `on_top` llegó a crearse en producción, pero se comprueba
-- antes de cerrar: si existiera alguna, el CHECK fallaría al añadirse y sería
-- peor enterarse a mitad de la migración.
update public.pricing_rules
set markup_mode = 'absorbed'
where markup_mode = 'on_top';

alter table public.pricing_rules
  drop constraint if exists pricing_rules_mode_check;

alter table public.pricing_rules
  add constraint pricing_rules_mode_check
  check (markup_mode = 'absorbed');

comment on constraint pricing_rules_mode_check on public.pricing_rules is
  'Solo `absorbed`: el comercio paga la comisión de su precio. `on_top` exigiría que el catálogo pintara los precios con margen, y hasta entonces mostraría un precio y cobraría otro.';

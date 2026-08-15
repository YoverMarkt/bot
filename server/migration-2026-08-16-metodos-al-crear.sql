-- ═══════════════════════════════════════════════════════════════════════════
-- UN NEGOCIO NUEVO NACE SABIENDO CÓMO LE PAGAN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El cinturón `orders_check_payment_method` rechaza un pedido cuyo método el
-- local no acepta. Correcto — pero la migración anterior solo asignó métodos a
-- los negocios QUE YA EXISTÍAN. Un negocio dado de alta después nacía con
-- CERO, así que su tienda no podía cobrar de ninguna forma.
--
-- No es teórico: lo destapó el verificador del CI al primer intento, sobre un
-- negocio recién creado. En producción habría aparecido con el siguiente
-- cliente que se diera de alta, y con la tienda ya publicada.
--
-- ── POR QUÉ UN DISPARADOR Y NO EL ALTA ────────────────────────────────────
--
-- Podría ir dentro de `create_business_onboarding`, pero eso es recrear la
-- función que da de alta clientes —la que en agosto de 2026 estuvo rota meses
-- por un disparador mal puesto— por un añadido pequeño. Un disparador sobre
-- `businesses` cubre además CUALQUIER camino de creación: el onboarding, una
-- inserción directa, un importador futuro.
--
-- ── QUÉ NACE ENCENDIDO ────────────────────────────────────────────────────
--
-- Todos los métodos disponibles reciben su fila, para que el dueño los vea en
-- su panel como interruptores. Pero **solo `transferencia` nace encendida**.
--
-- Es la decisión del dueño de la plataforma (2026-08-16): empezar solo con
-- transferencia y encender el efectivo cuando la operación esté rodada. Y es
-- la que tiene sentido: la transferencia es el modo BARATO —el dinero entra
-- antes de entregar, así que no hay plantones que costar, ni adelantos, ni
-- efectivo que controlar—.
--
-- ⚠️ Sigue la misma regla que las plantillas de catálogo, las capacidades y el
-- tiempo de preparación: **solo recomienda AL CREAR y jamás pisa a un negocio
-- existente.** El `on conflict do nothing` lo garantiza.
--
-- ⚠️ Y no puede tumbar un alta: si algo falla aquí, el negocio se crea igual y
-- el dueño enciende sus métodos a mano. Un cliente sin dar de alta es peor que
-- un cliente con los interruptores por configurar.
--
-- ⚠️ Sin `begin`/`commit`: la transacción la abre el ejecutor.

create or replace function public.businesses_seed_payment_methods()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    insert into public.business_payment_methods (business_id, method_code, enabled, sort)
    select
      new.id,
      pm.code,
      -- Solo la transferencia nace encendida. El resto queda visible y
      -- apagado, para que el dueño lo encienda cuando quiera.
      pm.code = 'transferencia',
      pm.sort
    from public.payment_methods pm
    where pm.available
    on conflict (business_id, method_code) do nothing;
  exception when others then
    -- Nunca tumba el alta. Un cliente sin crear es peor que uno con los
    -- métodos por configurar.
    null;
  end;
  return new;
end;
$$;

drop trigger if exists businesses_seed_payment_methods on public.businesses;
create trigger businesses_seed_payment_methods
  after insert on public.businesses
  for each row execute function public.businesses_seed_payment_methods();

-- ============================================================
-- El número de la plataforma no se lo puede quedar un local
-- ============================================================
--
-- ⚠️ ESTO NACE DE UN FALLO REAL, encontrado el 2026-08-22 escribiendo al
-- número de Umbani desde un teléfono: en vez de las categorías del
-- marketplace contestaba **el enlace de la mini app de Monster Pizza**.
--
-- La causa no estaba en el código, que hacía exactamente lo que se le pidió.
-- Estaba en la CONFIGURACIÓN, que se quedó de la etapa anterior: Monster
-- Pizza tenía `whatsapp_number = ycloud_number = +593991716574`, el mismo
-- número que la plataforma. Y en `webhooks.routes.ts` el orden es implacable:
--
--   1. `resolveBusinessChannel(...)`  ← encuentra al local dueño del número
--   2. …y SOLO si no encuentra ninguno, cae a la rama del marketplace
--
-- Así que la rama del marketplace no se ejecutaba nunca. Todo lo construido
-- para el número único —las 15 categorías, la búsqueda, el pedido en el chat,
-- el buzón de comprobantes— estaba vivo y era inalcanzable.
--
-- ⚠️ Es el MISMO patrón que ya mordió tres veces a este proyecto:
-- `shopping_locked` (columna, texto y pruebas, sin la línea que la encendía),
-- el menú del marketplace (construido y desconectado) y el buzón de
-- comprobantes del marketplace. Las pruebas no lo cazan porque no hay nada
-- roto que cazar: el fallo es que la configuración real no lleva a ese código.
--
-- Por eso la defensa va en la BASE y no en el panel. Quitar el campo de la
-- pantalla evita el error de dedo; solo una guarda aquí evita que vuelva a
-- entrar por una API, una migración, un script o un `update` a mano.

create or replace function public.businesses_no_pisan_el_numero_plataforma()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plataforma text;
  v_propuesto text;
begin
  -- El número de la plataforma vive en `server_settings`, no en un negocio:
  -- no pertenece a ningún local. Si no está configurado, no hay nada que
  -- proteger todavía y el disparador no estorba.
  select nullif(btrim(s.value), '') into v_plataforma
  from public.server_settings s
  where s.key = 'platform_ycloud_number';

  if v_plataforma is null then
    return new;
  end if;

  -- Se comparan SOLO los dígitos: el mismo teléfono se escribe «+593…» en un
  -- sitio y «593…» en otro, y comparar en crudo dejaría pasar exactamente el
  -- caso que esto existe para impedir. Es el mismo criterio que
  -- `esNumeroDePlataforma` en `services/platform-channel.ts`.
  v_plataforma := regexp_replace(v_plataforma, '\D', '', 'g');

  foreach v_propuesto in array array[
    coalesce(new.whatsapp_number, ''),
    coalesce(new.ycloud_number, ''),
    coalesce(new.meta_phone_id, '')
  ] loop
    v_propuesto := regexp_replace(v_propuesto, '\D', '', 'g');
    if v_propuesto <> '' and v_propuesto = v_plataforma then
      raise exception using
        errcode = '23514',
        message = 'Ese número es el del marketplace y no puede ser de un local',
        hint = 'Los locales viven en el marketplace (whatsapp_provider = '
             || '''marketplace''), sin número propio. Si un local se queda con '
             || 'el número de la plataforma, los mensajes de TODOS los clientes '
             || 'le llegan a él y el menú del marketplace deja de responder.';
    end if;
  end loop;

  return new;
end;
$$;

-- BEFORE: tiene que abortar ANTES de que `sync_business_channel_identifiers`
-- llegue a escribir el identificador que secuestra el enrutado.
drop trigger if exists businesses_numero_de_plataforma on public.businesses;
create trigger businesses_numero_de_plataforma
  before insert or update of whatsapp_number, ycloud_number, meta_phone_id
  on public.businesses
  for each row execute function public.businesses_no_pisan_el_numero_plataforma();

-- ═══════════════════════════════════════════════════════════════════════════
-- «ABIERTO 24 HORAS» SE DICE, NO SE TRUCA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `business_schedule` guarda un tramo por día —`open_time`, `close_time`— y
-- hasta hoy no tenía forma de decir «este día no cierro». Lo más parecido era
-- escribir `00:00 – 23:59` y confiar en que `cierreEfectivo` entiende ese
-- 23:59 como el final del día.
--
-- Eso es un truco, con tres costes reales:
--
--   · NADIE lo deduce. El panel enseña dos relojes y ninguno sugiere que
--     medianoche a 23:59 signifique «todo el día».
--   · Lo intuitivo ROMPE EN SILENCIO. Quien pone `00:00 – 00:00` —la lectura
--     natural de «de medianoche a medianoche»— se queda con un tramo de
--     duración cero, y el local sale CERRADO el día entero sin un aviso. El
--     dueño se entera por un cliente que no pudo pedir.
--   · El dato MIENTE. Una fila que dice 23:59 donde se quiso decir 24:00 hace
--     que cualquiera que lea la tabla mañana —o cualquier código nuevo—
--     tenga que conocer el truco para no equivocarse.
--
-- La columna lo dice y se acabó: `is_24h = true` significa que ese día se
-- atiende entero.
--
-- ⚠️ NO se retira `cierreEfectivo`, y la distinción importa. El 23:59 tiene
-- DOS usos y solo uno era un truco. El que se queda es el del dueño
-- (2026-09-02): partir la noche en dos filas —«lunes 08:00–23:59» + «martes
-- 00:00–03:00»— para cubrir la madrugada sin cruzar la medianoche. Ahí el
-- 23:59 sigue significando «hasta el final del día», y tratarlo de otro modo
-- dejaría ese local cerrado un minuto entero justo antes de las doce, en hora
-- punta. Lo que desaparece es la necesidad de escribirlo para decir 24 horas.
--
-- ⚠️ `is_active` sigue siendo quien dice «este día NO se abre». `is_24h` no
-- lo sustituye ni lo contradice: un día inactivo está cerrado aunque lleve la
-- marca, porque `activeDays` lo filtra antes de mirar nada más.
--
-- ⚠️ Nace en `false` y eso no cambia el horario de NADIE: todos los locales de
-- hoy siguen exactamente con el tramo que tenían. Las dos funciones de alta
-- (`create_business_with_owner`, `provision_business`) siembran el horario sin
-- nombrar esta columna, así que caen al default sin tocarlas.
--
-- ⚠️ `open_time`/`close_time` NO se retiran ni se vacían con la marca puesta:
-- son `not null`, y conservar el tramo que había permite quitar el 24 h y
-- recuperar el horario anterior sin volver a escribirlo.
--
-- Aditiva e idempotente: no borra ni reescribe una sola fila.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.business_schedule
  add column if not exists is_24h boolean not null default false;

comment on column public.business_schedule.is_24h is
  'Ese día se atiende las 24 horas. Manda sobre open_time/close_time, que se conservan para poder volver al horario anterior. No sustituye a is_active: un día inactivo está cerrado.';

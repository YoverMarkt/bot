/**
 * Formato de dinero para PINTAR. El importe que se cobra siempre viene del
 * servidor: aquí solo se le pone el símbolo delante.
 */
export const money = (value: number | null | undefined, currency = 'USD'): string => {
  if (value == null || !Number.isFinite(value)) return ''
  const simbolo = currency === 'USD' ? '$' : `${currency} `
  return `${simbolo}${value.toFixed(2)}`
}

/**
 * La hora como la dice la gente en Ecuador y Colombia: «9:00 AM», «3:00 AM».
 *
 * El servidor manda `HH:MM` en 24 h porque es el formato en el que no hay
 * ambigüedad al compararlo, y ese sigue siendo el que viaja. Esto es SOLO para
 * pintar.
 *
 * ⚠️ Las dos horas que rompen cualquier versión ingenua de esto son las que
 * este negocio tiene de verdad: `00:xx` es **12 AM**, no «0 AM», y `12:xx` es
 * **12 PM**, no «0 PM». El resto de la tabla sale de un módulo 12, pero esas
 * dos no. Monster Pizza abre 09:00 y cierra 03:00, así que el cruce de la
 * medianoche no es un caso teórico aquí.
 *
 * ⚠️ Sin ceros a la izquierda en la hora («9:00 AM», no «09:00 AM») porque es
 * como se escribe, pero SÍ en los minutos («9:05», no «9:5»).
 */
export const hora12 = (hhmm: string | null | undefined): string => {
  const texto = String(hhmm || '').trim()
  const partes = /^(\d{1,2}):(\d{2})/.exec(texto)
  // Una hora que no se entiende se devuelve tal cual: es mejor enseñar
  // «09:00» que inventar un «NaN:00 AM» delante del cliente.
  if (!partes) return texto
  const horas = Number(partes[1])
  const minutos = partes[2]
  if (!Number.isInteger(horas) || horas < 0 || horas > 23) return texto
  const sufijo = horas < 12 ? 'AM' : 'PM'
  const doce = horas % 12 === 0 ? 12 : horas % 12
  return `${doce}:${minutos} ${sufijo}`
}

/**
 * El tiempo que se promete al cliente, siempre como RANGO: «25 – 35 min».
 *
 * El dueño configura UN número —«mi pizza tarda 25»—, que es como piensa en su
 * cocina; preguntarle dos sería el doble de fricción para el mismo dato. La
 * ventana de 10 minutos la pone la app, igual que hacen las apps de delivery:
 * un número exacto se lee como una promesa al minuto, y el primer pedido que
 * llegue en 27 la incumple.
 */
export const rangoDeEspera = (minutos: number): string => {
  const desde = Math.max(1, Math.round(minutos))
  return `${desde} – ${desde + 10} min`
}

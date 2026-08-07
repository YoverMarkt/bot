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

/**
 * Una franja horaria en las palabras del cliente: «Hoy 13:30», «Mañana 09:00»
 * o «mié 15 · 12:00».
 *
 * Se lee en hora de ECUADOR, no la del teléfono: el negocio abre a las 9 allí,
 * y un cliente con el móvil en otro huso vería horas que no existen.
 */
export function etiquetaFranja(iso: string): string {
  const cuando = new Date(iso)
  if (Number.isNaN(cuando.getTime())) return ''
  const zona = 'America/Guayaquil'
  const dia = (fecha: Date) => fecha.toLocaleDateString('en-CA', { timeZone: zona })

  const hora = cuando.toLocaleTimeString('es-EC', {
    timeZone: zona, hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const hoy = new Date()
  const manana = new Date(hoy.getTime() + 24 * 60 * 60 * 1000)

  if (dia(cuando) === dia(hoy)) return `Hoy ${hora}`
  if (dia(cuando) === dia(manana)) return `Mañana ${hora}`
  const fecha = cuando.toLocaleDateString('es-EC', {
    timeZone: zona, weekday: 'short', day: 'numeric',
  })
  return `${fecha} · ${hora}`
}

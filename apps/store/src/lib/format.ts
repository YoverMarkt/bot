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

/**
 * Formato de dinero para PINTAR. El importe que se cobra siempre viene del
 * servidor: aquí solo se le pone el símbolo delante.
 */
export const money = (value: number | null | undefined, currency = 'USD'): string => {
  if (value == null || !Number.isFinite(value)) return ''
  const simbolo = currency === 'USD' ? '$' : `${currency} `
  return `${simbolo}${value.toFixed(2)}`
}

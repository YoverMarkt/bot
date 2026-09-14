// ── Cómo se LEE una regla de margen ───────────────────────────────────
//
// ⚠️ Vivía dentro de `Finance.tsx` y se saca aquí para poder probarlo: es
// texto de DINERO que lee el superadmin para decidir cuánto cobra la
// plataforma, y una etiqueta equivocada le hace tomar una decisión sobre una
// cifra que no es. No cambia una coma de su comportamiento.
import type { PricingRule } from '../clients/api'

export const dinero = (v: number | string) => `$${Number(v || 0).toFixed(2)}`

// ⚠️ `family` sigue AQUÍ aunque ya no se pueda crear desde el desplegable: la
// lista tiene que saber pintar una regla antigua de ese ámbito. Se retira la
// puerta de entrada, no la capacidad de leer lo que ya existe.
export const ETIQUETA_AMBITO: Record<PricingRule['scope'], string> = {
  family: 'Una familia',
  business: 'Un negocio',
  business_type: 'Un tipo',
  global: 'Toda la plataforma',
}

export const ETIQUETA_ESTRATEGIA: Record<PricingRule['strategy'], string> = {
  percentage: 'Porcentaje',
  fixed: 'Monto fijo',
  tiered: 'Por tramos',
}

/** Cómo cobra una regla, en una línea legible. */
export const comoCobra = (r: PricingRule): string => {
  const frenos = [
    r.min_amount != null ? `mínimo ${dinero(r.min_amount)}` : null,
    r.max_amount != null ? `máximo ${dinero(r.max_amount)}` : null,
  ].filter(Boolean).join(' · ')

  const base = r.strategy === 'percentage' ? `${r.percentage}%`
    : r.strategy === 'fixed' ? dinero(r.fixed_amount || 0)
      : `${r.tiers?.length || 0} tramos`

  return frenos ? `${base} — ${frenos}` : base
}


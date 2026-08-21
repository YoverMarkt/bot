import type { SupabaseClient } from '@supabase/supabase-js'
import type { PricingRuleInput } from '../types'

const db: SupabaseClient = require('../client') as typeof import('../client')

// ═══════════════════════════════════════════════════════════════════════════
// REGLAS DE MARGEN DE LA PLATAFORMA
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo que decide cuánto gana la plataforma con cada pedido. Quien lo COBRA es
// `calculate_platform_markup` en PostgreSQL, sellado por un disparador sobre
// `orders` (regla inviolable #8): aquí solo se administran las reglas.
//
// ⚠️ Una regla con `business_id` nulo es GLOBAL y afecta a todos los negocios
// del SaaS. Solo el superadmin llega a estas funciones.

const listPricingRules = async () => {
  const { data, error } = await db
    .from('pricing_rules')
    .select('*,businesses(name)')
    .order('status', { ascending: true })
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data || []
}

const createPricingRule = async (rule: PricingRuleInput) => db
  .from('pricing_rules')
  .insert(rule)
  .select()
  .single()

/**
 * Archivar en vez de borrar.
 *
 * Un pedido guarda `pricing_rule_id` como rastro histórico y sin clave
 * foránea: si la regla se borrara, quedaría un pedido apuntando a una regla
 * que ya no se puede consultar, y «¿por qué a este le cobramos $3?» dejaría de
 * tener respuesta. Archivada sale de la resolución igual que si no existiera.
 */
const archivePricingRule = async (id: string) => db
  .from('pricing_rules')
  .update({ status: 'archived', updated_at: new Date().toISOString() })
  .eq('id', id)
  .select()
  .single()

/**
 * Cambiar una regla crea una versión NUEVA y archiva la anterior.
 *
 * No se edita en sitio a propósito: los pedidos ya sellados apuntan a la
 * versión que les tocó, y reescribirla haría que un pedido de febrero dijera
 * que se le cobró un porcentaje que en febrero no existía (§41).
 */
const replacePricingRule = async (id: string, rule: PricingRuleInput) => {
  const { data: anterior, error: errorLectura } = await db
    .from('pricing_rules')
    .select('version')
    .eq('id', id)
    .single()
  if (errorLectura) throw new Error(errorLectura.message)

  // El archivado va PRIMERO: el índice único impide dos reglas activas para el
  // mismo destino, así que insertar antes fallaría.
  const { error: errorArchivo } = await db
    .from('pricing_rules')
    .update({ status: 'archived', updated_at: new Date().toISOString() })
    .eq('id', id)
  if (errorArchivo) throw new Error(errorArchivo.message)

  return db
    .from('pricing_rules')
    .insert({ ...rule, version: Number(anterior?.version || 0) + 1 })
    .select()
    .single()
}

/**
 * Cuánto lleva acumulado cada comercio en un periodo.
 *
 * ⚠️ `businessId` nulo devuelve TODOS los negocios y es solo para el panel del
 * superadmin. La ruta del comercio pasa siempre el `businessId` de su JWT.
 */
const getPlatformMarkupSummary = async (
  from: string,
  to: string,
  businessId: string | null = null,
) => {
  const { data, error } = await db.rpc('platform_markup_summary', {
    p_from: from,
    p_to: to,
    p_business_id: businessId,
  })
  if (error) throw new Error(error.message)
  return data || []
}

/**
 * Cierra un mes: recalcula la comisión y la escribe en la factura.
 *
 * Idempotente por naturaleza —no suma, RECALCULA desde `sales` y escribe el
 * valor absoluto—, así que correrla a diario es seguro y es justo lo que hace
 * la tarea programada. Un mes ya pagado no se reescribe.
 */
const settleMonthCommission = async (periodStart: string) => {
  const { data, error } = await db.rpc('settle_month_commission', {
    p_period_start: periodStart,
  })
  if (error) throw new Error(error.message)
  return data as {
    periodo: string
    facturas_afectadas: number
    comision_total: number
    ya_pagadas: number
  }
}

/**
 * Arrastra al mes que se cierra lo que cambió en meses YA PAGADOS.
 *
 * Una factura emitida no se reescribe, así que si una venta se anula después
 * de cobrarla, la diferencia se descuenta aquí. Es idempotente por el reclamo
 * de `billing_adjustments`: un periodo se salda una sola vez.
 */
const carryCommissionAdjustments = async (periodStart: string) => {
  const { data, error } = await db.rpc('carry_commission_adjustments', {
    p_period_start: periodStart,
  })
  if (error) throw new Error(error.message)
  return data as { periodo: string, ajustes: number, total_ajustado: number }
}

/** Las familias —comida y retail—, para el desplegable del panel. */
const listBusinessFamilies = async () => {
  const { data, error } = await db
    .from('business_families')
    .select('code, label, sort')
    .order('sort')
  if (error) throw new Error(error.message)
  return data || []
}

export = {
  listPricingRules,
  listBusinessFamilies,
  settleMonthCommission,
  carryCommissionAdjustments,
  createPricingRule,
  archivePricingRule,
  replacePricingRule,
  getPlatformMarkupSummary,
}

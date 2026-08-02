import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const migrationSource = readFileSync(
  `${serverDir}/migration-facturacion-planes.sql`,
  'utf8',
)
const migration = migrationSource.toLowerCase()
const correccion = readFileSync(
  `${serverDir}/migration-arreglo-cuota-alta.sql`,
  'utf8',
)
const schema = readFileSync(`${serverDir}/schema.sql`, 'utf8')
const indexSource = readFileSync(`${serverDir}/src/index.ts`, 'utf8')
const reportsSource = readFileSync(
  `${serverDir}/src/services/reports.ts`,
  'utf8',
)
const billingRoutesSource = readFileSync(
  `${serverDir}/src/routes/admin-billing.routes.ts`,
  'utf8',
)

describe('automatización mensual de facturación', () => {
  // El consolidado ya NO puede terminar copiando la migración de planes tal
  // cual: aquella dejaba el disparador en BEFORE y eso impedía dar de alta
  // cualquier cliente (2026-08-02). Lo que debe cumplirse es que una
  // instalación nueva desde schema.sql acabe donde acaba una base existente
  // tras aplicar la migración de planes MÁS su corrección.
  it('consolida el mismo estado final en instalaciones nuevas', () => {
    // Todo lo de la migración salvo su última sentencia (el disparador) sigue
    // palabra por palabra en el consolidado.
    const cuerpo = migrationSource
      .trimEnd()
      .slice(0, migrationSource.trimEnd().lastIndexOf('create trigger billing_claim_month'))
    expect(cuerpo.length).toBeGreaterThan(0)
    expect(schema).toContain(cuerpo.trimEnd())
  })

  it('el disparador de la cuota corre DESPUÉS de escribir la factura', () => {
    // BEFORE apuntaba con billing_id a una fila de billing que aún no existía,
    // y la clave foránea tumbaba toda la transacción del alta.
    expect(schema).toContain(
      'create trigger billing_claim_month\nafter insert or update of business_id',
    )
    expect(schema).not.toContain(
      'create trigger billing_claim_month\nbefore insert or update of business_id',
    )
    expect(correccion).toContain(
      'create trigger billing_claim_month\nafter insert or update of business_id',
    )
  })

  it('preserva cobros existentes y reclama atómicamente cada negocio/mes', () => {
    expect(migration).toContain('create table if not exists public.billing_month_claims')
    expect(migration).toContain('primary key (business_id, period_start)')
    expect(migration).toContain(
      "date_trunc('month', billing.period_start)::date",
    )
    expect(migration).toContain('create trigger billing_claim_month')
    expect(migration).toContain('when unique_violation then null')
    expect(migration).not.toMatch(/\bdelete\s+from\s+public\.billing\b/)
    expect(migration).not.toMatch(/\btruncate\s+(table\s+)?public\.billing\b/)
  })

  it('usa el calendario de Ecuador y solo factura negocios habilitados', () => {
    expect(migration).toContain("timezone('america/guayaquil', now())")
    expect(migration).toContain('business.active is true')
    expect(migration).toContain(
      'coalesce(business.suspended, false) is false',
    )
    expect(migration).toContain('business.monthly_rate > 0')
    expect(migration).toContain(
      'create or replace function public.ensure_current_month_billing()',
    )
    expect(indexSource).toContain('setTimeout(generateCurrentMonthBilling, 3000)')
    expect(indexSource).toContain(
      'setInterval(generateCurrentMonthBilling, 24 * 60 * 60 * 1000)',
    )
  })

  it('crea una sola cuota en el onboarding con los seis planes y sus límites', () => {
    for (const [plan, rate, contacts, messages] of [
      ['micro', 25, 50, 250],
      ['basic', 50, 200, 1000],
      ['pro', 99, 400, 2000],
      ['growth', 199, 800, 4000],
      ['scale', 499, 2000, 10000],
      ['enterprise', 899, 4000, 20000],
    ]) {
      expect(migration).toMatch(new RegExp(
        `\\('${plan}'::text,\\s*${rate}::numeric,\\s*${contacts},\\s*${messages}\\)`,
      ))
    }
    expect(migration).toContain(
      'create or replace function public.billing_plan_definition',
    )
    expect(migration).toContain(
      'la tarifa o los límites no coinciden con el catálogo del plan',
    )
    expect(migration).toContain("alter column plan set default 'micro'")
    expect(migration).toContain(
      'monthly_contact_limit,\n    monthly_outbound_message_limit',
    )
    expect(migration).toContain('lodging_enabled,\n    chat_mode,')
    expect(migration).not.toContain('generate_series')
    expect(migration).not.toContain('plan_expires_at')
    expect(migration).not.toMatch(/\bcustom\b/)
  })

  it('migra solo premium a scale sin reescribir cobros ni otras tarifas', () => {
    expect(migration).toContain(
      "set plan = 'scale'\nwhere lower(btrim(coalesce(plan, ''))) = 'premium'",
    )
    expect(migration).not.toMatch(
      /update\s+public\.billing[\s\S]*?where\s+lower\(btrim\(coalesce\(plan/,
    )
  })

  it('reactiva y cambia de plan en RPC transaccionales sin tocar pagados históricos', () => {
    expect(migration).toContain(
      'create or replace function public.reactivate_business_with_billing',
    )
    expect(migration).toContain(
      'create or replace function public.update_business_plan_billing',
    )
    expect(migration).toContain("and status = 'pending'")
    expect(migration).toContain('and period_start >= v_period_start')
    expect(migration).not.toContain("status = 'paid'")
  })

  it('retira la creación manual y toda acción automática por vencimiento', () => {
    expect(billingRoutesSource).not.toContain(
      "router.post('/api/admin/billing'",
    )
    expect(indexSource).not.toContain('checkExpiredClients')
    expect(indexSource).not.toContain('getExpiredBusinesses')
    expect(indexSource).not.toContain('Plan vencido')
    expect(reportsSource).not.toContain('plan_expires_at')
    expect(reportsSource).not.toContain('Tu plan vence')
  })
})

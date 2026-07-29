import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const migration = readFileSync(
  `${serverDir}/migration-whatsapp-flows.sql`,
  'utf8',
)

function functionBlock(name) {
  const start = migration.indexOf(`create or replace function public.${name}`)
  expect(start, `${name} debe existir`).toBeGreaterThanOrEqual(0)
  const end = migration.indexOf('$$;', start)
  expect(end, `${name} debe cerrar su cuerpo`).toBeGreaterThan(start)
  return migration.slice(start, end + 3)
}

describe('migración productiva de WhatsApp Flows', () => {
  it('es aditiva, transaccional y modela capacidades futuras sin enum de giros', () => {
    expect(migration).toContain('begin;')
    expect(migration).toContain('commit;')
    expect(migration).toContain('create table if not exists public.whatsapp_flow_definitions')
    expect(migration).toContain('create table if not exists public.whatsapp_flow_versions')
    expect(migration).toContain("capability_key ~ '^[a-z][a-z0-9_.-]{1,63}$'")
    expect(migration).toContain(
      'unique (business_id, provider, waba_id, flow_key)',
    )
    expect(migration).not.toMatch(
      /capability_key[^;]+in \('order','appointment','lodging','lead'\)/s,
    )
  })

  it('versiona por WABA/proveedor y deja una sola versión activa', () => {
    expect(migration).toContain(
      'constraint whatsapp_flow_versions_definition_fk foreign key',
    )
    expect(migration).toContain(
      'id, business_id, provider, waba_id',
    )
    expect(migration).toContain('uq_whatsapp_flow_active_version')
    expect(migration).toContain('uq_whatsapp_flow_enabled_capability')
    expect(migration).toContain('where is_active is true')
    const activation = functionBlock('activate_whatsapp_flow_version')
    expect(activation).toContain("v_version.status <> 'published'")
    expect(activation).toContain('v_version.provider_flow_id is null')
    expect(activation).not.toContain('set enabled = true')
    expect(migration).toContain(
      'constraint whatsapp_flow_versions_published_check',
    )
    expect(functionBlock('enforce_enabled_whatsapp_flow_definition'))
      .toContain("flow_version.status = 'published'")
  })

  it('no guarda tokens ni contactos en claro y usa CAS para el contexto', () => {
    expect(migration).toContain('session_token_hash')
    expect(migration).toContain('contact_key_hash')
    expect(migration).not.toMatch(/\bsession_token\s+text\b/)
    expect(migration).not.toMatch(/\bcontact_phone\s+text\b/)
    expect(migration).toContain('context_revision')

    const resolve = functionBlock('resolve_whatsapp_flow_session')
    expect(resolve).not.toContain("'session_token_hash'")
    expect(resolve).not.toContain("'contact_key_hash'")

    const update = functionBlock('update_whatsapp_flow_session_context')
    expect(update).toContain('v_session.context_revision <> p_expected_revision')
    expect(update).toContain("'result', 'stale'")
    expect(update).toContain('context_revision = context_revision + 1')
  })

  it('reclama el submission una sola vez por sesión y evento del proveedor', () => {
    expect(migration).toContain(
      'unique (business_id, provider, provider_submission_key_hash)',
    )
    expect(migration).toContain('unique (session_id)')
    const record = functionBlock('record_whatsapp_flow_submission')
    expect(record).toContain('for update')
    expect(record).toContain('session.contact_key_hash = p_contact_key_hash')
    expect(record).toContain("'created', false")
    expect(record).toContain("'created', true")
    expect(record).toContain("v_session.status <> 'open'")
  })

  it('crea el pedido una sola vez con precios y modificadores releídos', () => {
    expect(migration).toContain('add column if not exists flow_submission_id uuid')
    expect(migration).toContain('uq_orders_flow_submission')
    expect(migration).toContain(
      "add column if not exists modifier_ids uuid[] not null default '{}'::uuid[]",
    )
    expect(migration).toContain('add column if not exists item_note text')
    const createOrder = functionBlock('create_order_from_flow_submission')
    expect(createOrder).toContain('for update')
    expect(createOrder).toContain(
      'select session.*, definition.capability_key as resolved_capability_key',
    )
    expect(createOrder).not.toMatch(/into\s+v_session\s*,/)
    expect(createOrder).toContain(
      "v_session.resolved_capability_key = 'order'",
    )
    expect(createOrder).toContain('from public.products as product')
    expect(createOrder).toContain('product.business_id = p_business_id')
    expect(createOrder).toContain('v_product.price_sale')
    expect(createOrder).toContain('from public.menu_modifiers as modifier')
    expect(createOrder).toContain('lower(btrim(modifier.category_tag))')
    expect(createOrder).toContain("'áéíóúüñ'")
    expect(createOrder).toContain('insert into public.orders')
    expect(createOrder).toContain('insert into public.order_items')
    expect(createOrder).toContain('public.set_order_fulfillment(')
    expect(createOrder).toContain("'created', false")
    expect(createOrder).toContain("'created', true")
    expect(createOrder).toContain(
      "when v_product.price_sale > 0 then v_product.price_sale",
    )
  })

  it('agrega fulfillment y recalcula total incluyendo delivery_fee', () => {
    for (const field of [
      'fulfillment_type',
      'delivery_address',
      'delivery_reference',
      'payment_method',
      'requested_fulfillment_at',
      'customer_notes',
      'delivery_fee',
    ]) {
      expect(migration).toContain(field)
    }
    const normalize = functionBlock('normalize_order_fulfillment_total')
    expect(normalize).toContain('+ new.delivery_fee')
    expect(functionBlock('set_order_fulfillment'))
      .toContain("v_type not in ('delivery', 'pickup', 'onsite')")
  })

  it('crea únicamente un draft HELD para deliveries confirmados', () => {
    expect(migration).toContain(
      'create table if not exists public.delivery_dispatch_outbox',
    )
    expect(migration).toContain("status                   text not null default 'held'")
    expect(migration).toContain(
      'unique (business_id, order_id, event_type)',
    )
    const ensure = functionBlock('ensure_order_delivery_dispatch')
    expect(ensure).toContain(
      "v_order.status is distinct from 'confirmado'",
    )
    expect(ensure).toContain(
      "v_order.fulfillment_type is distinct from 'delivery'",
    )
    expect(ensure).toContain("'held'")
    expect(ensure).toContain(
      'on conflict (business_id, order_id, event_type) do update',
    )
    expect(ensure).toContain(
      "public.delivery_dispatch_outbox.status = 'cancelled'",
    )
    expect(ensure).toContain('then null')
    const trigger = functionBlock('enqueue_confirmed_delivery_dispatch')
    expect(trigger).toContain(
      "new.status is distinct from 'confirmado'",
    )
    expect(trigger).toContain('public.cancel_held_delivery_dispatch(')
    expect(trigger).not.toContain(
      'update public.delivery_dispatch_outbox',
    )
    const cancel = functionBlock('cancel_held_delivery_dispatch')
    expect(cancel).toContain("dispatch.status = 'held'")
    expect(cancel).toContain("dispatch.status = 'cancelled'")
    expect(cancel).not.toContain("'pending'")
    expect(cancel).not.toContain("'processing'")
    expect(cancel).not.toContain("'sent'")
    expect(migration).not.toContain('lease_delivery_dispatch')
    expect(migration).not.toContain('send_delivery_dispatch')
  })

  it('blinda el outbox sin escritura directa para service_role', () => {
    expect(migration).toContain(
      'revoke all on function public.cancel_held_delivery_dispatch(uuid, uuid)',
    )
    expect(migration).toContain(
      'grant execute on function public.cancel_held_delivery_dispatch(uuid, uuid)',
    )
    expect(migration).toMatch(
      /grant select\s+on table public\.delivery_dispatch_outbox to service_role;/,
    )
    expect(migration).not.toMatch(
      /grant\s+[^;]*(?:insert|update|delete)[^;]*\s+on table public\.delivery_dispatch_outbox to service_role;/i,
    )
  })

  it('aísla todas las tablas nuevas detrás de RLS y service_role', () => {
    for (const table of [
      'whatsapp_flow_definitions',
      'whatsapp_flow_versions',
      'whatsapp_flow_sessions',
      'whatsapp_flow_submissions',
      'whatsapp_flow_metric_events',
      'delivery_dispatch_recipients',
      'delivery_dispatch_outbox',
    ]) {
      expect(migration).toContain(
        `alter table public.${table} enable row level security`,
      )
    }
    expect(migration).toContain(
      'from public, anon, authenticated, service_role',
    )
    expect(migration).toContain(
      'grant execute on function public.record_whatsapp_flow_submission',
    )
  })
})

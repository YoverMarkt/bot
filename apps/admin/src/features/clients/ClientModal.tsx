import { useEffect, useState } from 'react'
import * as adm from './api'
import type { BusinessPayload } from './api'
import { RadioTower, Search } from 'lucide-react'
import { Button } from '@botpanel/ui/components/button'
import { Input } from '@botpanel/ui/components/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@botpanel/ui/components/select'
import { Label } from '@botpanel/ui/components/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@botpanel/ui/components/dialog'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import {
  BUSINESS_TYPE_OPTIONS,
  CUSTOM_BUSINESS_TYPE,
  businessTypeChoice,
  recommendedChatModeForBusinessType,
  recommendedStorefrontForBusinessType,
  recommendedSalesForBusinessType,
} from './business-types'
import { PLAN_CATALOG, planById } from './plans'

// Modal de crear/editar negocio — paridad con el panel viejo:
// identidad, canal WhatsApp por proveedor (con verificación real),
// modo de venta, IA por negocio, plan/tarifa y acceso del dueño.

const EMPTY = {
  name: '', type: 'negocio', whatsapp_number: '', owner_phone: '',
  // Un local NUEVO nace en el marketplace: se atiende por el número de la
  // plataforma y no necesita cuenta de YCloud. Era 'ycloud' hasta el
  // 2026-08-21, y eso obligaba a acordarse de cambiarlo — si no, el alta pedía
  // credenciales de una cuenta que ese local no va a tener nunca.
  //
  // ⚠️ Solo afecta al alta. Al EDITAR se lee el proveedor guardado (más abajo),
  // así que ningún negocio con canal propio se ve reescrito.
  whatsapp_provider: 'marketplace', ycloud_api_key: '',
  ycloud_webhook_endpoint_id: '', ycloud_webhook_secret: '',
  meta_token: '', meta_phone_id: '',
  telegram_bot_token: '',
  ai_provider: '', sales: 'informa',
  chat_mode: 'menu', storefront: 'no',
  plan: 'micro', monthly_rate: '25',
  monthly_contact_limit: '50', monthly_outbound_message_limit: '250',
  client_email: '', client_password: '', notes: '',
}

export default function ClientModal({ id, onClose, onSaved }: { id: string | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState(EMPTY)
  const [savedCredentials, setSavedCredentials] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(!!id)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [vfy, setVfy] = useState('')
  const [salesTouched, setSalesTouched] = useState(false)
  const [storefrontTouched, setStorefrontTouched] = useState(false)
  const [chatModeTouched, setChatModeTouched] = useState(false)
  const [applyPlanDefaults, setApplyPlanDefaults] = useState(false)

  // Editar → cargar el detalle real (el server nunca manda esto a paneles de cliente)
  useEffect(() => {
    if (!id) return
    adm.getClient(id).then(c => {
      setSavedCredentials(c.credential_status || {})
      setF({
        name: c.name ?? '', type: c.type ?? 'negocio',
        whatsapp_number: c.whatsapp_number ?? '', owner_phone: c.owner_phone ?? '',
        whatsapp_provider: c.whatsapp_provider ?? 'ycloud',
        ycloud_api_key: '',
        ycloud_webhook_endpoint_id: c.ycloud_webhook_endpoint_id ?? '',
        ycloud_webhook_secret: '',
        meta_token: '', meta_phone_id: c.meta_phone_id ?? '',
        telegram_bot_token: '',
        ai_provider: c.ai_provider ?? '',
        sales: c.takes_orders === false ? 'informa' : 'vende',
        storefront: c.storefront_enabled ? 'yes' : 'no',
        chat_mode: ['menu', 'miniapp'].includes(String(c.chat_mode)) ? String(c.chat_mode) : 'menu',
        plan: planById(c.plan)?.id ?? c.plan ?? 'micro',
        monthly_rate: c.monthly_rate != null ? String(c.monthly_rate) : '',
        monthly_contact_limit: c.monthly_contact_limit != null
          ? String(c.monthly_contact_limit)
          : '',
        monthly_outbound_message_limit: c.monthly_outbound_message_limit != null
          ? String(c.monthly_outbound_message_limit)
          : '',
        client_email: c.client_email ?? '', client_password: '',
        notes: c.notes ?? '',
      })
      setLoading(false)
    }).catch(e => { setError(e instanceof Error ? e.message : 'Error'); setLoading(false) })
  }, [id])

  // Versión para los Select de Radix (entregan el valor directo, no un evento)
  const setVal = (k: keyof typeof EMPTY) => (value: string) => setF(prev => ({ ...prev, [k]: value }))

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const value = e.target.value
    setF(prev => {
      const next = { ...prev, [k]: value }
      // Presugerir el modo según el tipo SOLO al crear (al editar se respeta lo guardado)
      if (k === 'type' && !id && !salesTouched) {
        next.sales = recommendedSalesForBusinessType(value)
      }
      if (k === 'type' && !id && !chatModeTouched) {
        next.chat_mode = recommendedChatModeForBusinessType(value)
      }
      if (k === 'type' && !id && !storefrontTouched) {
        next.storefront = recommendedStorefrontForBusinessType(value) ? 'yes' : 'no'
      }
      return next
    })
  }

  const selectBusinessType = (value: string) => {
    setF(prev => {
      const type = value === CUSTOM_BUSINESS_TYPE ? '' : value
      return {
        ...prev,
        type,
        sales: id || salesTouched ? prev.sales : recommendedSalesForBusinessType(type),
        chat_mode: id || chatModeTouched
          ? prev.chat_mode
          : recommendedChatModeForBusinessType(type),
        storefront: id || storefrontTouched
          ? prev.storefront
          : recommendedStorefrontForBusinessType(type) ? 'yes' : 'no',
      }
    })
  }

  const selectPlan = (value: string) => {
    const preset = planById(value)
    if (!preset) return
    setApplyPlanDefaults(true)
    setF(prev => ({
      ...prev,
      plan: preset.id,
      monthly_rate: String(preset.monthlyRate),
      monthly_contact_limit: String(preset.monthlyContactLimit),
      monthly_outbound_message_limit: String(preset.monthlyOutboundMessageLimit),
    }))
  }

  const requestVerification = () => {
    const payload: adm.ProviderVerificationPayload = {
      provider: f.whatsapp_provider as adm.ProviderVerificationPayload['provider'],
      ycloud_api_key: f.ycloud_api_key || undefined,
      ycloud_number: f.whatsapp_number.trim(),
      // Se envían para que la verificación avise si falta lo del webhook; en
      // blanco el servidor usa lo ya guardado del negocio.
      ycloud_webhook_secret: f.ycloud_webhook_secret || undefined,
      ycloud_webhook_endpoint_id: f.ycloud_webhook_endpoint_id.trim() || undefined,
      meta_token: f.meta_token || undefined,
      meta_phone_id: f.meta_phone_id.trim(),
      telegram_bot_token: f.telegram_bot_token || undefined,
    }
    return id ? adm.verifyClient(id, payload) : adm.verifyProvider(payload)
  }

  async function verify() {
    setVfy('Verificando credenciales…')
    try {
      const r = await requestVerification()
      setVfy(`${r.ok ? '✓' : '✗'} ${r.info}`)
    } catch (e) { setVfy(`✗ ${e instanceof Error ? e.message : 'Error'}`) }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const sinCanalPropio = f.whatsapp_provider === 'marketplace'
    if (!f.name.trim()) { setError('El nombre es obligatorio'); return }
    if (!sinCanalPropio && !f.whatsapp_number.trim()) { setError('El número de WhatsApp es obligatorio'); return }
    // En el marketplace es el ÚNICO número del negocio, y es lo que le deja
    // pedir sus reportes por WhatsApp. Sin él, el local nace sin forma de que
    // su dueño lo alcance desde el chat.
    if (sinCanalPropio && !id && !f.owner_phone.trim()) {
      setError('El WhatsApp del dueño es obligatorio: es con lo que pide sus reportes')
      return
    }
    if (!id && !(parseFloat(f.monthly_rate) > 0)) { setError('Selecciona un plan con una tarifa mensual válida'); return }
    if (!id && (!f.client_email.trim() || !f.client_password)) { setError('El correo y la contraseña del dueño son obligatorios al crear'); return }
    const payload: BusinessPayload = {
      name: f.name.trim(), type: f.type.trim() || 'negocio',
      whatsapp_number: sinCanalPropio ? null : f.whatsapp_number.trim(),
      owner_phone: f.owner_phone.trim() || null,
      whatsapp_provider: f.whatsapp_provider as BusinessPayload['whatsapp_provider'],
      ycloud_number: sinCanalPropio ? null : (f.whatsapp_number.trim() || null),
      ycloud_webhook_endpoint_id: sinCanalPropio ? null : (f.ycloud_webhook_endpoint_id.trim() || null),
      meta_phone_id: sinCanalPropio ? null : (f.meta_phone_id || null),
      ai_provider: f.ai_provider || null,
      takes_orders: f.sales !== 'informa',
      // Un negocio que deja de vender no puede quedarse con la tienda
      // encendida: abriría una app vacía.
      storefront_enabled: f.storefront === 'yes' && f.sales !== 'informa',
      chat_mode: (['menu', 'miniapp'] as const).find(modo => modo === f.chat_mode) ?? 'menu',
      notes: f.notes || null,
    }
    const officialPlan = planById(f.plan)
    if (officialPlan) {
      payload.plan = officialPlan.id
      payload.monthly_rate = parseFloat(f.monthly_rate) || null
      payload.monthly_contact_limit = f.monthly_contact_limit
        ? Number(f.monthly_contact_limit)
        : null
      payload.monthly_outbound_message_limit = f.monthly_outbound_message_limit
        ? Number(f.monthly_outbound_message_limit)
        : null
      if (id && applyPlanDefaults) payload.apply_plan_defaults = true
    }
    if (f.ycloud_api_key.trim()) payload.ycloud_api_key = f.ycloud_api_key.trim()
    if (f.ycloud_webhook_secret.trim()) {
      payload.ycloud_webhook_secret = f.ycloud_webhook_secret.trim()
    }
    if (f.meta_token.trim()) payload.meta_token = f.meta_token.trim()
    if (f.telegram_bot_token.trim()) payload.telegram_bot_token = f.telegram_bot_token.trim()
    if (f.client_email) payload.client_email = f.client_email.trim()
    if (f.client_password) payload.client_password = f.client_password
    setSaving(true)
    // Un negocio nuevo no debe quedar activo con un canal que no funciona.
    // Al editar se conserva la posibilidad de guardar otros cambios aunque el
    // proveedor esté temporalmente fuera de línea.
    //
    // ⚠️ El marketplace se salta la verificación porque no tiene credenciales
    // que verificar. Sin esta condición el alta era IMPOSIBLE: el verificador
    // no conoce el proveedor, responde `ok:false`, y al crear eso aborta el
    // guardado con «No se creó el negocio: Proveedor no reconocido».
    if (!sinCanalPropio
      && (f.whatsapp_provider !== 'telegram' || f.telegram_bot_token || (id && savedCredentials.telegram_bot_token))) {
      setVfy('Verificando credenciales…')
      try {
        const vr = await requestVerification()
        if (!vr.ok && !id) {
          setError(`No se creó el negocio: ${vr.info}`)
          setVfy(`✗ ${vr.info}`)
          setSaving(false)
          return
        }
        setVfy(vr.ok ? `✓ ${vr.info}` : `Atención: ${vr.info}`)
      } catch (verificationError) {
        if (!id) {
          setError(`No se creó el negocio: ${verificationError instanceof Error ? verificationError.message : 'no se pudo verificar el canal'}`)
          setVfy('✗ No se pudo verificar el canal')
          setSaving(false)
          return
        }
        setVfy('Atención: No se pudo verificar el canal')
      }
    }
    try {
      if (id) await adm.updateClient(id, payload)
      else await adm.createClient(payload)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar')
    } finally { setSaving(false) }
  }

  // La tienda solo tiene sentido si hay algo que vender. Un negocio que solo
  // informa abriría una app vacía, así que ni se ofrece.
  const puedeTenerTienda = f.sales !== 'informa'

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
      <form onSubmit={save}>
        <DialogHeader className="mb-4">
          <DialogTitle>{id ? 'Editar negocio' : 'Nuevo negocio'}</DialogTitle>
          <DialogDescription>Configura identidad, canales, plan y acceso del negocio.</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-9 w-full" />
              </div>
            ))}
          </div>
        ) : (
          <>
            {/* Identidad */}
            <div className="grid grid-cols-1 gap-3 mb-4 sm:grid-cols-2">
              <div><Label htmlFor="client-name">Nombre *</Label><Input id="client-name" value={f.name} onChange={set('name')} placeholder="Pizzería Don Luigi" /></div>
              <div>
                <Label htmlFor="client-business-type">Tipo de negocio</Label>
                <Select value={businessTypeChoice(f.type)} onValueChange={selectBusinessType}>
                  <SelectTrigger id="client-business-type" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {BUSINESS_TYPE_OPTIONS.map(option => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                    <SelectItem value={CUSTOM_BUSINESS_TYPE}>Escribir otro tipo…</SelectItem>
                  </SelectContent>
                </Select>
                {businessTypeChoice(f.type) === CUSTOM_BUSINESS_TYPE && (
                  <Input id="client-custom-business-type" aria-label="Otro tipo de negocio" className="mt-2" value={f.type} onChange={set('type')} placeholder="Ej: centro de yoga" />
                )}
              </div>
              {/* El negocio del marketplace se atiende por el número de la
                  plataforma, así que no tiene uno propio que pedirle. El campo
                  se oculta en vez de quedarse vacío: la base lo rechazaría. */}
              {f.whatsapp_provider !== 'marketplace' && (
                <div><Label htmlFor="client-whatsapp-number">WhatsApp del negocio *</Label><Input id="client-whatsapp-number" value={f.whatsapp_number} onChange={set('whatsapp_number')} placeholder="+593…" /></div>
              )}
              <div><Label htmlFor="client-owner-phone">WhatsApp del dueño (reportes){f.whatsapp_provider === 'marketplace' ? ' *' : ''}</Label><Input id="client-owner-phone" value={f.owner_phone} onChange={set('owner_phone')} placeholder="+593… (solo él pide reportes)" /></div>
            </div>

            {/* Modos */}
            <div className="grid grid-cols-1 gap-3 mb-4 md:grid-cols-2">
              <div>
                <Label htmlFor="client-sales-mode">Ventas por el bot</Label>
                <Select value={f.sales} onValueChange={value => {
                  setSalesTouched(true)
                  setVal('sales')(value)
                }}>
                  <SelectTrigger id="client-sales-mode" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="vende">Crea pedidos con total oficial</SelectItem>
                    <SelectItem value="informa" disabled={f.chat_mode === 'miniapp'}>Solo informa y deriva</SelectItem>
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">Informar permite precios, descripciones, fotos y videos; no crea pedidos ni solicita pagos.</p>
              </div>
              <div>
                <Label htmlFor="client-chat-mode">Quién conduce la conversación</Label>
                <Select value={f.chat_mode} onValueChange={value => {
                  setChatModeTouched(true)
                  if (value === 'miniapp') {
                    setSalesTouched(true)
                    setStorefrontTouched(true)
                    setF(prev => ({
                      ...prev,
                      chat_mode: 'miniapp',
                      sales: 'vende',
                      storefront: 'yes',
                    }))
                  } else {
                    setVal('chat_mode')(value)
                  }
                }}>
                  <SelectTrigger id="client-chat-mode" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="miniapp">Mini app (enlace para pedir)</SelectItem>
                    <SelectItem value="menu">Menú de opciones en el chat</SelectItem>
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">
                  <strong>Mini app</strong>: responde con el enlace y el pedido se hace en la app, sin usar IA.
                  {' '}<strong>Menú</strong>: el cliente elige entre opciones armadas con los datos reales; nada se inventa ni cuesta IA.
                  {' '}<strong>IA</strong>: conversa libre y pide por chat. El servidor calcula los totales en los tres.
                </p>
              </div>
              <div>
                <Label htmlFor="client-storefront">Mini app de la tienda</Label>
                <Select
                  value={f.storefront}
                  onValueChange={value => {
                    setStorefrontTouched(true)
                    setVal('storefront')(value)
                  }}
                  disabled={!puedeTenerTienda}
                >
                  <SelectTrigger id="client-storefront" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="no" disabled={f.chat_mode === 'miniapp'}>Solo chat</SelectItem>
                    <SelectItem value="yes">El bot manda su enlace de tienda</SelectItem>
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">
                  {puedeTenerTienda
                    ? 'El cliente recibe por WhatsApp un enlace personal para armar su pedido. Enciéndela con el catálogo ya cargado: una tienda vacía se ve peor que ninguna.'
                    : 'Necesita crear pedidos. Un negocio que solo informa no tendría nada que mostrar en la tienda.'}
                </p>
              </div>
              <div>
                <Label htmlFor="client-ai-provider">IA de este negocio</Label>
                {/* Radix no permite value="" en un item → centinela 'global' ↔ '' */}
                <Select value={f.ai_provider || 'global'} onValueChange={v => setVal('ai_provider')(v === 'global' ? '' : v)}>
                  <SelectTrigger id="client-ai-provider" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="global">Global del servidor</SelectItem>
                    <SelectItem value="groq">Groq (Llama)</SelectItem>
                    <SelectItem value="deepseek">DeepSeek</SelectItem>
                    <SelectItem value="gemini">Gemini</SelectItem>
                    <SelectItem value="claude">Claude</SelectItem>
                    <SelectItem value="openai">OpenAI</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Canal WhatsApp */}
            <div className="rounded-xl border p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <span id="client-whatsapp-provider-label" className="inline-flex items-center gap-1.5"><RadioTower className="w-4 h-4" /> Canal de WhatsApp</span>
                <Select value={f.whatsapp_provider} onValueChange={setVal('whatsapp_provider')}>
                  <SelectTrigger id="client-whatsapp-provider" aria-labelledby="client-whatsapp-provider-label" className="w-44"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="marketplace">Marketplace (sin número propio)</SelectItem>
                    <SelectItem value="ycloud">YCloud</SelectItem>
                    <SelectItem value="meta">Meta (oficial)</SelectItem>
                    <SelectItem value="telegram">Solo Telegram</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {f.whatsapp_provider === 'ycloud' && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div><Label htmlFor="client-ycloud-api-key">YCloud API Key {savedCredentials.ycloud_api_key && '— guardada'}</Label><Input id="client-ycloud-api-key" type="password" value={f.ycloud_api_key} onChange={set('ycloud_api_key')} placeholder={savedCredentials.ycloud_api_key ? 'Escribe solo para reemplazarla' : ''} /></div>
                  <div><Label htmlFor="client-ycloud-endpoint-id">Webhook Endpoint ID</Label><Input id="client-ycloud-endpoint-id" value={f.ycloud_webhook_endpoint_id} onChange={set('ycloud_webhook_endpoint_id')} placeholder="Cópialo desde Developers → Webhooks" /></div>
                  <div><Label htmlFor="client-ycloud-signing-secret">Webhook Signing Secret {savedCredentials.ycloud_webhook_secret && '— guardado'}</Label><Input id="client-ycloud-signing-secret" type="password" value={f.ycloud_webhook_secret} onChange={set('ycloud_webhook_secret')} placeholder={savedCredentials.ycloud_webhook_secret ? 'Escribe solo para reemplazarlo' : 'whsec_…'} /></div>
                </div>
              )}
              {f.whatsapp_provider === 'meta' && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div><Label htmlFor="client-meta-token">Meta Token {savedCredentials.meta_token && '— guardado'}</Label><Input id="client-meta-token" type="password" value={f.meta_token} onChange={set('meta_token')} placeholder={savedCredentials.meta_token ? 'Escribe solo para reemplazarlo' : ''} /></div>
                  <div><Label htmlFor="client-meta-phone-id">Phone ID</Label><Input id="client-meta-phone-id" value={f.meta_phone_id} onChange={set('meta_phone_id')} /></div>
                </div>
              )}
              {/* Sin canal propio no hay credenciales que guardar ni que
                  verificar: el verificador consultaría una cuenta que no
                  existe y devolvería un fallo que no significa nada. */}
              {f.whatsapp_provider === 'marketplace' ? (
                <p className="text-xs text-muted-foreground mt-1">
                  Este negocio se atiende por el número del marketplace. No necesita número propio, cuenta de YCloud ni webhook.
                </p>
              ) : (
                <>
                  <div className="mt-3">
                    <div><Label htmlFor="client-telegram-token">Telegram Bot Token {savedCredentials.telegram_bot_token ? '— guardado' : '(opcional)'}</Label><Input id="client-telegram-token" type="password" value={f.telegram_bot_token} onChange={set('telegram_bot_token')} placeholder={savedCredentials.telegram_bot_token ? 'Escribe solo para reemplazarlo' : ''} /></div>
                  </div>
                  <div className="flex items-center gap-3 mt-3">
                    <Button variant="outline" size="sm" type="button" onClick={verify} >
                      <span className="inline-flex items-center gap-1"><Search className="w-3.5 h-3.5" /> Verificar credenciales</span>
                    </Button>
                    {vfy && <span className="text-xs text-foreground/80">{vfy}</span>}
                  </div>
                </>
              )}
            </div>

            {/* Plan y facturación */}
            <div className="mb-4 rounded-lg border border-border/70 p-3">
              <h3 className="mb-3 text-sm font-semibold">Plan y facturación automática</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="client-plan">Plan</Label>
                <Select value={f.plan} onValueChange={selectPlan}>
                  <SelectTrigger id="client-plan" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {!planById(f.plan) && (
                      <SelectItem value={f.plan} disabled>Plan anterior: {f.plan}</SelectItem>
                    )}
                    {PLAN_CATALOG.map(plan => (
                      <SelectItem key={plan.id} value={plan.id}>
                        {plan.label} — ${plan.monthlyRate}/mes · {plan.monthlyContactLimit.toLocaleString('es-EC')} / {plan.monthlyOutboundMessageLimit.toLocaleString('es-EC')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="client-monthly-rate">Tarifa mensual ($)</Label>
                <Input id="client-monthly-rate" type="number" step="0.01" value={f.monthly_rate} readOnly aria-describedby="client-plan-help" />
              </div>
              <div>
                <Label htmlFor="client-contact-limit">Contactos al mes</Label>
                <Input
                  id="client-contact-limit"
                  type="number"
                  min="1"
                  step="1"
                  value={f.monthly_contact_limit}
                  readOnly
                  aria-describedby="client-plan-help"
                />
              </div>
              <div>
                <Label htmlFor="client-outbound-limit">Mensajes enviados al mes</Label>
                <Input
                  id="client-outbound-limit"
                  type="number"
                  min="1"
                  step="1"
                  value={f.monthly_outbound_message_limit}
                  readOnly
                  aria-describedby="client-plan-help"
                />
              </div>
              </div>
              <p id="client-plan-help" className="mt-3 text-xs text-muted-foreground">
                La tarifa y los límites pertenecen al plan seleccionado. Cada mes se crea una sola cuota automáticamente; Medición alerta los excesos y la suspensión por falta de pago continúa siendo manual.
              </p>
              {id && planById(f.plan) && (
                <Button
                  className="mt-3"
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => selectPlan(f.plan)}
                >
                  Aplicar valores vigentes del plan
                </Button>
              )}
            </div>

            {/* Acceso del dueño */}
            <div className="grid grid-cols-1 gap-3 mb-4 sm:grid-cols-2">
              <div><Label htmlFor="client-owner-email">Correo del dueño (panel)</Label><Input id="client-owner-email" type="email" value={f.client_email} onChange={set('client_email')} /></div>
              <div><Label htmlFor="client-owner-password">Contraseña {id ? '(solo si cambia)' : 'del panel'}</Label><Input id="client-owner-password" type="password" minLength={12} value={f.client_password} onChange={set('client_password')} /></div>
              <div className="sm:col-span-2"><Label htmlFor="client-internal-notes">Notas internas</Label><Input id="client-internal-notes" value={f.notes} onChange={set('notes')} /></div>
            </div>

            {!id && <p className="mb-4 text-xs text-muted-foreground">Se creará un horario inicial de lunes a viernes, 09:00–18:00, y sábado, 09:00–13:00. El dueño puede cambiarlo inmediatamente desde Horarios.</p>}

            {error && <p role="alert" className="text-sm text-destructive mb-3">✗ {error}</p>}

            <DialogFooter className="mx-0 mb-0 px-0 pb-0">
              <Button variant="outline" type="button" onClick={onClose}>Cancelar</Button>
              <Button disabled={saving}>
                {saving ? 'Guardando…' : id ? 'Guardar cambios' : 'Crear negocio'}
              </Button>
            </DialogFooter>
          </>
        )}
      </form>
      </DialogContent>
    </Dialog>
  )
}

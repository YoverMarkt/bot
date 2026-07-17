import { useEffect, useState } from 'react'
import * as adm from './api'
import type { BusinessPayload } from './api'
import { BedDouble, RadioTower, Search } from 'lucide-react'
import { Button } from '@botpanel/ui/components/button'
import { Input } from '@botpanel/ui/components/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@botpanel/ui/components/select'
import { Label } from '@botpanel/ui/components/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@botpanel/ui/components/dialog'
import { Alert, AlertDescription, AlertTitle } from '@botpanel/ui/components/alert'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import {
  BUSINESS_TYPE_OPTIONS,
  CUSTOM_BUSINESS_TYPE,
  businessTypeChoice,
  isLodgingBusinessType,
  recommendedLodgingForBusinessType,
  recommendedModeForBusinessType,
  recommendedSalesForBusinessType,
} from './business-types'

// Modal de crear/editar negocio — paridad con el panel viejo:
// identidad, canal WhatsApp por proveedor (con verificación real),
// modos (citas / venta), IA por negocio, plan/tarifa y acceso del dueño.

const EMPTY = {
  name: '', type: 'negocio', whatsapp_number: '', owner_phone: '',
  whatsapp_provider: 'ycloud', ycloud_api_key: '',
  meta_token: '', meta_phone_id: '', meta_verify_token: '',
  kapso_api_key: '', kapso_number_id: '', kapso_verify_token: '',
  telegram_bot_token: '', retell_agent_id: '',
  ai_provider: '', mode: 'normal', sales: 'informa',
  lodging: 'no',
  plan: 'basic', monthly_rate: '', plan_expires_at: '',
  client_email: '', client_password: '', notes: '',
}

export default function ClientModal({ id, onClose, onSaved }: { id: string | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState(EMPTY)
  const [savedCredentials, setSavedCredentials] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(!!id)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [vfy, setVfy] = useState('')
  const [modeTouched, setModeTouched] = useState(false)
  const [salesTouched, setSalesTouched] = useState(false)
  const [lodgingTouched, setLodgingTouched] = useState(false)

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
        meta_token: '', meta_phone_id: c.meta_phone_id ?? '', meta_verify_token: '',
        kapso_api_key: '', kapso_number_id: c.kapso_number_id ?? '', kapso_verify_token: '',
        telegram_bot_token: '',
        retell_agent_id: c.retell_agent_id ?? '',
        ai_provider: c.ai_provider ?? '',
        mode: c.takes_bookings ? 'citas' : 'normal',
        sales: c.takes_orders === false ? 'informa' : 'vende',
        lodging: c.lodging_enabled ? 'yes' : 'no',
        plan: c.plan ?? 'basic',
        monthly_rate: c.monthly_rate != null ? String(c.monthly_rate) : '',
        plan_expires_at: c.plan_expires_at ? c.plan_expires_at.slice(0, 10) : '',
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
      if (k === 'type' && !id && !modeTouched) {
        next.mode = recommendedModeForBusinessType(value)
      }
      if (k === 'type' && !id && !salesTouched) {
        next.sales = recommendedSalesForBusinessType(value)
      }
      if (k === 'type' && !id && !lodgingTouched) {
        next.lodging = recommendedLodgingForBusinessType(value) ? 'yes' : 'no'
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
        mode: id || modeTouched ? prev.mode : recommendedModeForBusinessType(type),
        sales: id || salesTouched ? prev.sales : recommendedSalesForBusinessType(type),
        lodging: id || lodgingTouched
          ? prev.lodging
          : recommendedLodgingForBusinessType(type) ? 'yes' : 'no',
      }
    })
  }

  const requestVerification = () => {
    const typedSecret = f.whatsapp_provider === 'ycloud' ? f.ycloud_api_key
      : f.whatsapp_provider === 'meta' ? f.meta_token
      : f.whatsapp_provider === 'kapso' ? f.kapso_api_key
      : f.telegram_bot_token
    if (id && !typedSecret) return adm.verifyClient(id)
    return adm.verifyProvider({
      provider: f.whatsapp_provider,
      ycloud_api_key: f.ycloud_api_key || undefined,
      ycloud_number: f.whatsapp_number || undefined,
      meta_token: f.meta_token || undefined,
      meta_phone_id: f.meta_phone_id || undefined,
      kapso_api_key: f.kapso_api_key || undefined,
      kapso_number_id: f.kapso_number_id || undefined,
      telegram_bot_token: f.telegram_bot_token || undefined,
    })
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
    if (!f.name.trim() || !f.whatsapp_number.trim()) { setError('Nombre y número de WhatsApp son obligatorios'); return }
    if (!id && !(parseFloat(f.monthly_rate) > 0)) { setError('La tarifa mensual es obligatoria al crear (genera la facturación)'); return }
    if (!id && (!f.client_email.trim() || !f.client_password)) { setError('El correo y la contraseña del dueño son obligatorios al crear'); return }
    const payload: BusinessPayload = {
      name: f.name.trim(), type: f.type.trim() || 'negocio',
      whatsapp_number: f.whatsapp_number.trim(),
      owner_phone: f.owner_phone.trim() || null,
      whatsapp_provider: f.whatsapp_provider as BusinessPayload['whatsapp_provider'],
      ycloud_number: f.whatsapp_number.trim() || null,
      meta_phone_id: f.meta_phone_id || null,
      kapso_number_id: f.kapso_number_id || null,
      retell_agent_id: f.retell_agent_id || null,
      ai_provider: f.ai_provider || null,
      takes_bookings: f.mode === 'citas',
      takes_orders: f.sales !== 'informa',
      lodging_enabled: f.lodging === 'yes',
      plan: f.plan,
      monthly_rate: parseFloat(f.monthly_rate) || null,
      plan_expires_at: f.plan_expires_at || null,
      notes: f.notes || null,
    }
    if (f.ycloud_api_key.trim()) payload.ycloud_api_key = f.ycloud_api_key.trim()
    if (f.meta_token.trim()) payload.meta_token = f.meta_token.trim()
    if (f.meta_verify_token.trim()) payload.meta_verify_token = f.meta_verify_token.trim()
    if (f.kapso_api_key.trim()) payload.kapso_api_key = f.kapso_api_key.trim()
    if (f.kapso_verify_token.trim()) payload.kapso_verify_token = f.kapso_verify_token.trim()
    if (f.telegram_bot_token.trim()) payload.telegram_bot_token = f.telegram_bot_token.trim()
    if (f.client_email) payload.client_email = f.client_email.trim()
    if (f.client_password) payload.client_password = f.client_password
    setSaving(true)
    // Un negocio nuevo no debe quedar activo con un canal que no funciona.
    // Al editar se conserva la posibilidad de guardar otros cambios aunque el
    // proveedor esté temporalmente fuera de línea.
    if (f.whatsapp_provider !== 'telegram' || f.telegram_bot_token || (id && savedCredentials.telegram_bot_token)) {
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
              <div><Label htmlFor="client-whatsapp-number">WhatsApp del negocio *</Label><Input id="client-whatsapp-number" value={f.whatsapp_number} onChange={set('whatsapp_number')} placeholder="+593…" /></div>
              <div><Label htmlFor="client-owner-phone">WhatsApp del dueño (reportes)</Label><Input id="client-owner-phone" value={f.owner_phone} onChange={set('owner_phone')} placeholder="+593… (solo él pide reportes)" /></div>
            </div>

            {/* Modos */}
            <div className="grid grid-cols-1 gap-3 mb-4 md:grid-cols-2">
              <div>
                <Label htmlFor="client-booking-mode">Agenda del bot</Label>
                <Select value={f.mode} onValueChange={value => {
                  setModeTouched(true)
                  setVal('mode')(value)
                }}>
                  <SelectTrigger id="client-booking-mode" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="normal">Sin agenda — solo atención</SelectItem>
                    <SelectItem value="citas">Solicita citas — el dueño confirma</SelectItem>
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">Agenda simple de un solo recurso; las solicitudes quedan pendientes hasta que el dueño confirme o cancele.</p>
              </div>
              <div>
                <Label htmlFor="client-sales-mode">Ventas por el bot</Label>
                <Select value={f.sales} onValueChange={value => {
                  setSalesTouched(true)
                  setVal('sales')(value)
                }}>
                  <SelectTrigger id="client-sales-mode" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="vende">Crea pedidos con total oficial</SelectItem>
                    <SelectItem value="informa">Solo informa y deriva</SelectItem>
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">Informar permite precios, descripciones, fotos y videos; no crea pedidos ni solicita pagos.</p>
              </div>
              <div>
                <Label htmlFor="client-lodging-mode">Hospedaje</Label>
                <Select value={f.lodging} onValueChange={value => {
                  setLodgingTouched(true)
                  setVal('lodging')(value)
                }}>
                  <SelectTrigger id="client-lodging-mode" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="no">Sin cotización de estadías</SelectItem>
                    <SelectItem value="yes">Cotiza habitaciones y solicita confirmación</SelectItem>
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">Es independiente de citas y pedidos. El dueño o un empleado con permiso de hospedaje confirma cada solicitud.</p>
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

            {(isLodgingBusinessType(f.type) || f.lodging === 'yes') && (
              <Alert className="mb-4 border-primary/30 bg-primary/5">
                <BedDouble />
                <AlertTitle>Módulo de hospedaje independiente</AlertTitle>
                <AlertDescription>
                  El negocio configura habitaciones, cupos y tarifas. El bot puede cotizar con datos oficiales y retener temporalmente una opción, pero el equipo autorizado debe confirmarla; no genera pedidos.
                </AlertDescription>
              </Alert>
            )}

            {/* Canal WhatsApp */}
            <div className="rounded-xl border p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <span id="client-whatsapp-provider-label" className="inline-flex items-center gap-1.5"><RadioTower className="w-4 h-4" /> Canal de WhatsApp</span>
                <Select value={f.whatsapp_provider} onValueChange={setVal('whatsapp_provider')}>
                  <SelectTrigger id="client-whatsapp-provider" aria-labelledby="client-whatsapp-provider-label" className="w-44"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ycloud">YCloud</SelectItem>
                    <SelectItem value="meta">Meta (oficial)</SelectItem>
                    <SelectItem value="kapso">Kapso</SelectItem>
                    <SelectItem value="telegram">Solo Telegram</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {f.whatsapp_provider === 'ycloud' && (
                <div><Label htmlFor="client-ycloud-api-key">YCloud API Key {savedCredentials.ycloud_api_key && '— guardada'}</Label><Input id="client-ycloud-api-key" type="password" value={f.ycloud_api_key} onChange={set('ycloud_api_key')} placeholder={savedCredentials.ycloud_api_key ? 'Escribe solo para reemplazarla' : ''} /></div>
              )}
              {f.whatsapp_provider === 'meta' && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div><Label htmlFor="client-meta-token">Meta Token {savedCredentials.meta_token && '— guardado'}</Label><Input id="client-meta-token" type="password" value={f.meta_token} onChange={set('meta_token')} placeholder={savedCredentials.meta_token ? 'Escribe solo para reemplazarlo' : ''} /></div>
                  <div><Label htmlFor="client-meta-phone-id">Phone ID</Label><Input id="client-meta-phone-id" value={f.meta_phone_id} onChange={set('meta_phone_id')} /></div>
                  <div><Label htmlFor="client-meta-verify-token">Verify Token {savedCredentials.meta_verify_token && '— guardado'}</Label><Input id="client-meta-verify-token" type="password" value={f.meta_verify_token} onChange={set('meta_verify_token')} placeholder={savedCredentials.meta_verify_token ? 'Escribe solo para reemplazarlo' : ''} /></div>
                </div>
              )}
              {f.whatsapp_provider === 'kapso' && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div><Label htmlFor="client-kapso-api-key">Kapso API Key {savedCredentials.kapso_api_key && '— guardada'}</Label><Input id="client-kapso-api-key" type="password" value={f.kapso_api_key} onChange={set('kapso_api_key')} placeholder={savedCredentials.kapso_api_key ? 'Escribe solo para reemplazarla' : ''} /></div>
                  <div><Label htmlFor="client-kapso-number-id">Number ID</Label><Input id="client-kapso-number-id" value={f.kapso_number_id} onChange={set('kapso_number_id')} /></div>
                  <div><Label htmlFor="client-kapso-verify-token">Verify Token {savedCredentials.kapso_verify_token && '— guardado'}</Label><Input id="client-kapso-verify-token" type="password" value={f.kapso_verify_token} onChange={set('kapso_verify_token')} placeholder={savedCredentials.kapso_verify_token ? 'Escribe solo para reemplazarlo' : ''} /></div>
                </div>
              )}
              <div className="grid grid-cols-1 gap-3 mt-3 sm:grid-cols-2">
                <div><Label htmlFor="client-telegram-token">Telegram Bot Token {savedCredentials.telegram_bot_token ? '— guardado' : '(opcional)'}</Label><Input id="client-telegram-token" type="password" value={f.telegram_bot_token} onChange={set('telegram_bot_token')} placeholder={savedCredentials.telegram_bot_token ? 'Escribe solo para reemplazarlo' : ''} /></div>
                <div><Label htmlFor="client-retell-agent-id">Retell Agent ID (voz telefónica, opcional)</Label><Input id="client-retell-agent-id" value={f.retell_agent_id} onChange={set('retell_agent_id')} placeholder="agent_…" /></div>
              </div>
              <div className="flex items-center gap-3 mt-3">
                <Button variant="outline" size="sm" type="button" onClick={verify} >
                  <span className="inline-flex items-center gap-1"><Search className="w-3.5 h-3.5" /> Verificar credenciales</span>
                </Button>
                {vfy && <span className="text-xs text-foreground/80">{vfy}</span>}
              </div>
            </div>

            {/* Plan + acceso */}
            <div className="grid grid-cols-1 gap-3 mb-4 sm:grid-cols-3">
              <div>
                <Label htmlFor="client-plan">Plan</Label>
                <Select value={f.plan} onValueChange={setVal('plan')}>
                  <SelectTrigger id="client-plan" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="basic">Básico</SelectItem>
                    <SelectItem value="pro">Pro</SelectItem>
                    <SelectItem value="premium">Premium</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div><Label htmlFor="client-monthly-rate">Tarifa mensual ($)</Label><Input id="client-monthly-rate" type="number" step="0.01" value={f.monthly_rate} onChange={set('monthly_rate')} /></div>
              <div><Label htmlFor="client-plan-expires-at">Plan vence</Label><Input id="client-plan-expires-at" type="date" value={f.plan_expires_at} onChange={set('plan_expires_at')} /></div>
              <div><Label htmlFor="client-owner-email">Correo del dueño (panel)</Label><Input id="client-owner-email" type="email" value={f.client_email} onChange={set('client_email')} /></div>
              <div><Label htmlFor="client-owner-password">Contraseña {id ? '(solo si cambia)' : 'del panel'}</Label><Input id="client-owner-password" type="password" minLength={12} value={f.client_password} onChange={set('client_password')} /></div>
              <div><Label htmlFor="client-internal-notes">Notas internas</Label><Input id="client-internal-notes" value={f.notes} onChange={set('notes')} /></div>
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

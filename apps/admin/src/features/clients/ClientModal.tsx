import { useEffect, useState } from 'react'
import * as adm from './api'
import type { BusinessPayload } from './api'
import { RadioTower, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// Modal de crear/editar negocio — paridad con el panel viejo:
// identidad, canal WhatsApp por proveedor (con verificación real),
// modos (citas / venta), IA por negocio, plan/tarifa y acceso del dueño.

const input = 'w-full rounded-lg bg-muted border border-input text-foreground px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring'
const label = 'text-xs font-medium text-muted-foreground'

const EMPTY = {
  name: '', type: 'negocio', whatsapp_number: '', owner_phone: '',
  whatsapp_provider: 'ycloud', ycloud_api_key: '',
  meta_token: '', meta_phone_id: '', meta_verify_token: '',
  kapso_api_key: '', kapso_number_id: '', kapso_verify_token: '',
  telegram_bot_token: '', retell_agent_id: '',
  ai_provider: '', mode: 'normal', sales: 'vende',
  plan: 'basic', monthly_rate: '', plan_expires_at: '',
  client_email: '', client_password: '', notes: '',
}

export default function ClientModal({ id, onClose, onSaved }: { id: string | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState(EMPTY)
  const [loading, setLoading] = useState(!!id)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [vfy, setVfy] = useState('')

  // Editar → cargar el detalle real (el server nunca manda esto a paneles de cliente)
  useEffect(() => {
    if (!id) return
    adm.getClient(id).then(c => {
      setF({
        name: c.name ?? '', type: c.type ?? 'negocio',
        whatsapp_number: c.whatsapp_number ?? '', owner_phone: c.owner_phone ?? '',
        whatsapp_provider: c.whatsapp_provider ?? 'ycloud',
        ycloud_api_key: c.ycloud_api_key ?? '',
        meta_token: c.meta_token ?? '', meta_phone_id: c.meta_phone_id ?? '', meta_verify_token: c.meta_verify_token ?? '',
        kapso_api_key: c.kapso_api_key ?? '', kapso_number_id: c.kapso_number_id ?? '', kapso_verify_token: c.kapso_verify_token ?? '',
        telegram_bot_token: c.telegram_bot_token ?? '',
        retell_agent_id: c.retell_agent_id ?? '',
        ai_provider: c.ai_provider ?? '',
        mode: c.takes_bookings ? 'citas' : 'normal',
        sales: c.takes_orders === false ? 'informa' : 'vende',
        plan: c.plan ?? 'basic',
        monthly_rate: c.monthly_rate != null ? String(c.monthly_rate) : '',
        plan_expires_at: c.plan_expires_at ? c.plan_expires_at.slice(0, 10) : '',
        client_email: c.client_email ?? '', client_password: '',
        notes: c.notes ?? '',
      })
      setLoading(false)
    }).catch(e => { setError(e instanceof Error ? e.message : 'Error'); setLoading(false) })
  }, [id])

  const CALENDAR_TYPES = ['barbería', 'peluquería', 'salón', 'spa', 'clínica', 'consultorio', 'odontología', 'psicología', 'gym', 'entrenamiento', 'restaurante', 'masajes', 'estetica', 'estética']

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const value = e.target.value
    setF(prev => {
      const next = { ...prev, [k]: value }
      // Presugerir el modo según el tipo SOLO al crear (al editar se respeta lo guardado)
      if (k === 'type' && !id) next.mode = CALENDAR_TYPES.some(t => value.toLowerCase().includes(t)) ? 'citas' : 'normal'
      return next
    })
  }

  async function verify() {
    setVfy('Verificando credenciales…')
    try {
      const r = await adm.verifyProvider({
        provider: f.whatsapp_provider,
        ycloud_api_key: f.ycloud_api_key || undefined,
        ycloud_number: f.whatsapp_number || undefined,
        meta_token: f.meta_token || undefined,
        meta_phone_id: f.meta_phone_id || undefined,
        kapso_api_key: f.kapso_api_key || undefined,
        kapso_number_id: f.kapso_number_id || undefined,
        telegram_bot_token: f.telegram_bot_token || undefined,
      })
      setVfy(`${r.ok ? '✓' : '✗'} ${r.info}`)
    } catch (e) { setVfy(`✗ ${e instanceof Error ? e.message : 'Error'}`) }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!f.name.trim() || !f.whatsapp_number.trim()) { setError('Nombre y número de WhatsApp son obligatorios'); return }
    if (!id && !(parseFloat(f.monthly_rate) > 0)) { setError('La tarifa mensual es obligatoria al crear (genera la facturación)'); return }
    const payload: BusinessPayload = {
      name: f.name.trim(), type: f.type.trim() || 'negocio',
      whatsapp_number: f.whatsapp_number.trim(),
      owner_phone: f.owner_phone.trim() || null,
      whatsapp_provider: f.whatsapp_provider as BusinessPayload['whatsapp_provider'],
      ycloud_api_key: f.ycloud_api_key || null,
      ycloud_number: f.whatsapp_number.trim() || null,
      meta_token: f.meta_token || null, meta_phone_id: f.meta_phone_id || null, meta_verify_token: f.meta_verify_token || null,
      kapso_api_key: f.kapso_api_key || null, kapso_number_id: f.kapso_number_id || null, kapso_verify_token: f.kapso_verify_token || null,
      telegram_bot_token: f.telegram_bot_token || null,
      retell_agent_id: f.retell_agent_id || null,
      ai_provider: f.ai_provider || null,
      takes_bookings: f.mode === 'citas',
      takes_orders: f.sales !== 'informa',
      plan: f.plan,
      monthly_rate: parseFloat(f.monthly_rate) || null,
      plan_expires_at: f.plan_expires_at || null,
      notes: f.notes || null,
    }
    if (f.client_email) payload.client_email = f.client_email.trim()
    if (f.client_password) payload.client_password = f.client_password
    setSaving(true)
    // Verificar credenciales antes de guardar (igual que el viejo: avisa, pero guarda)
    if (f.whatsapp_provider !== 'telegram' || f.telegram_bot_token) {
      setVfy('Verificando credenciales…')
      try {
        const vr = await adm.verifyProvider({
          provider: f.whatsapp_provider,
          ycloud_api_key: f.ycloud_api_key || undefined,
          ycloud_number: f.whatsapp_number || undefined,
          meta_token: f.meta_token || undefined, meta_phone_id: f.meta_phone_id || undefined,
          kapso_api_key: f.kapso_api_key || undefined, kapso_number_id: f.kapso_number_id || undefined,
          telegram_bot_token: f.telegram_bot_token || undefined,
        })
        setVfy(vr.ok ? `✓ ${vr.info}` : `Atención: ${vr.info} — guardando de todas formas…`)
      } catch { setVfy('Atención: No se pudo verificar — guardando de todas formas…') }
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
    <div className="fixed inset-0 z-30 bg-black/60 flex items-start justify-center overflow-y-auto p-4" onClick={onClose}>
      <form onSubmit={save} onClick={e => e.stopPropagation()} className="w-full max-w-2xl bg-card border rounded-2xl p-6 my-8">
        <h2 className="text-lg font-bold text-foreground mb-4">{id ? 'Editar negocio' : 'Nuevo negocio'}</h2>

        {loading ? <p className="text-muted-foreground">Cargando datos…</p> : (
          <>
            {/* Identidad */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div><span className={label}>Nombre *</span><Input className={input} value={f.name} onChange={set('name')} placeholder="Pizzería Don Luigi" /></div>
              <div><span className={label}>Tipo de negocio</span><Input className={input} value={f.type} onChange={set('type')} placeholder="pizzería, barbería, tienda…" /></div>
              <div><span className={label}>WhatsApp del negocio *</span><Input className={input} value={f.whatsapp_number} onChange={set('whatsapp_number')} placeholder="+593…" /></div>
              <div><span className={label}>WhatsApp del dueño (reportes)</span><Input className={input} value={f.owner_phone} onChange={set('owner_phone')} placeholder="+593… (solo él pide reportes)" /></div>
            </div>

            {/* Modos */}
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div>
                <span className={label}>Modo de operación</span>
                <select className={input} value={f.mode} onChange={set('mode')}>
                  <option value="normal">🛒 Normal — venta/atención</option>
                  <option value="citas">📅 Con citas — agenda</option>
                </select>
              </div>
              <div>
                <span className={label}>Modo venta</span>
                <select className={input} value={f.sales} onChange={set('sales')}>
                  <option value="vende">🧾 Vende — cierra pedidos</option>
                  <option value="informa">💬 Solo informativo</option>
                </select>
              </div>
              <div>
                <span className={label}>IA de este negocio</span>
                <select className={input} value={f.ai_provider} onChange={set('ai_provider')}>
                  <option value="">Global del servidor</option>
                  <option value="groq">Groq (Llama)</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="gemini">Gemini</option>
                  <option value="claude">Claude</option>
                  <option value="openai">OpenAI</option>
                </select>
              </div>
            </div>

            {/* Canal WhatsApp */}
            <div className="rounded-xl border p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <span className="inline-flex items-center gap-1.5"><RadioTower className="w-4 h-4" /> Canal de WhatsApp</span>
                <select className={`${input} !w-44`} value={f.whatsapp_provider} onChange={set('whatsapp_provider')}>
                  <option value="ycloud">YCloud</option>
                  <option value="meta">Meta (oficial)</option>
                  <option value="kapso">Kapso</option>
                  <option value="telegram">Solo Telegram</option>
                </select>
              </div>
              {f.whatsapp_provider === 'ycloud' && (
                <div><span className={label}>YCloud API Key</span><Input className={input} type="password" value={f.ycloud_api_key} onChange={set('ycloud_api_key')} /></div>
              )}
              {f.whatsapp_provider === 'meta' && (
                <div className="grid grid-cols-3 gap-3">
                  <div><span className={label}>Meta Token</span><Input className={input} type="password" value={f.meta_token} onChange={set('meta_token')} /></div>
                  <div><span className={label}>Phone ID</span><Input className={input} value={f.meta_phone_id} onChange={set('meta_phone_id')} /></div>
                  <div><span className={label}>Verify Token</span><Input className={input} value={f.meta_verify_token} onChange={set('meta_verify_token')} /></div>
                </div>
              )}
              {f.whatsapp_provider === 'kapso' && (
                <div className="grid grid-cols-3 gap-3">
                  <div><span className={label}>Kapso API Key</span><Input className={input} type="password" value={f.kapso_api_key} onChange={set('kapso_api_key')} /></div>
                  <div><span className={label}>Number ID</span><Input className={input} value={f.kapso_number_id} onChange={set('kapso_number_id')} /></div>
                  <div><span className={label}>Verify Token</span><Input className={input} value={f.kapso_verify_token} onChange={set('kapso_verify_token')} /></div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div><span className={label}>Telegram Bot Token (opcional, para pruebas)</span><Input className={input} type="password" value={f.telegram_bot_token} onChange={set('telegram_bot_token')} /></div>
                <div><span className={label}>Retell Agent ID (voz telefónica, opcional)</span><Input className={input} value={f.retell_agent_id} onChange={set('retell_agent_id')} placeholder="agent_…" /></div>
              </div>
              <div className="flex items-center gap-3 mt-3">
                <Button variant="outline" size="sm" type="button" onClick={verify} >
                  <span className="inline-flex items-center gap-1"><Search className="w-3.5 h-3.5" /> Verificar credenciales</span>
                </Button>
                {vfy && <span className="text-xs text-foreground/80">{vfy}</span>}
              </div>
            </div>

            {/* Plan + acceso */}
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div>
                <span className={label}>Plan</span>
                <select className={input} value={f.plan} onChange={set('plan')}>
                  <option value="basic">Básico</option>
                  <option value="pro">Pro</option>
                  <option value="premium">Premium</option>
                </select>
              </div>
              <div><span className={label}>Tarifa mensual ($)</span><Input className={input} type="number" step="0.01" value={f.monthly_rate} onChange={set('monthly_rate')} /></div>
              <div><span className={label}>Plan vence</span><Input className={input} type="date" value={f.plan_expires_at} onChange={set('plan_expires_at')} /></div>
              <div><span className={label}>Correo del dueño (panel)</span><Input className={input} type="email" value={f.client_email} onChange={set('client_email')} /></div>
              <div><span className={label}>Contraseña {id ? '(solo si cambia)' : 'del panel'}</span><Input className={input} type="password" value={f.client_password} onChange={set('client_password')} /></div>
              <div><span className={label}>Notas internas</span><Input className={input} value={f.notes} onChange={set('notes')} /></div>
            </div>

            {error && <p className="text-sm text-destructive mb-3">✗ {error}</p>}

            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" type="button" onClick={onClose} >Cancelar</Button>
              <Button disabled={saving}>
                {saving ? 'Guardando…' : id ? 'Guardar cambios' : 'Crear negocio'}
              </Button>
            </div>
          </>
        )}
      </form>
    </div>
  )
}

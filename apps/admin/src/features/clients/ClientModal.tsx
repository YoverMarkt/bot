import { useEffect, useState } from 'react'
import * as adm from './api'
import type { BusinessPayload } from './api'
import { RadioTower } from 'lucide-react'
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
  chatModeSummary,
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
  sales: 'informa',
  chat_mode: 'menu', storefront: 'no',
  plan: 'micro', monthly_rate: '25',
  monthly_contact_limit: '50', monthly_outbound_message_limit: '250',
  client_email: '', client_password: '', notes: '',
}

export default function ClientModal({ id, onClose, onSaved }: { id: string | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState(EMPTY)
  const [loading, setLoading] = useState(!!id)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [salesTouched, setSalesTouched] = useState(false)
  const [storefrontTouched, setStorefrontTouched] = useState(false)
  const [applyPlanDefaults, setApplyPlanDefaults] = useState(false)

  // Editar → cargar el detalle real (el server nunca manda esto a paneles de cliente)
  useEffect(() => {
    if (!id) return
    adm.getClient(id).then(c => {
      setF({
        name: c.name ?? '', type: c.type ?? 'negocio',
        whatsapp_number: c.whatsapp_number ?? '', owner_phone: c.owner_phone ?? '',
        // ⚠️ `marketplace` y no `ycloud`: desde el 2026-08-23 ningún local
        // tiene canal propio. Con `ycloud` de defecto, un negocio sin
        // proveedor guardado abría el modal pidiendo credenciales de una
        // cuenta que no existe.
        whatsapp_provider: c.whatsapp_provider ?? 'marketplace',
        ycloud_api_key: '',
        ycloud_webhook_endpoint_id: c.ycloud_webhook_endpoint_id ?? '',
        ycloud_webhook_secret: '',
        meta_token: '', meta_phone_id: c.meta_phone_id ?? '',
        telegram_bot_token: '',
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

  // ⚠️ Aquí vivía `setVal`, el ayudante para los Select de Radix. Se queda sin
  // uso el 2026-08-23: los dos desplegables que quedaban en el modal —«Ventas
  // por el bot» y «Mini app de la tienda»— se fundieron en «Aparece en el
  // marketplace», que escribe los dos campos a la vez con `setEnMarketplace`.
  // El tipo de negocio y el plan tienen sus propios manejadores.

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const value = e.target.value
    setF(prev => {
      const next = { ...prev, [k]: value }
      // Presugerir el modo según el tipo SOLO al crear (al editar se respeta lo guardado)
      if (k === 'type' && !id && !salesTouched) {
        next.sales = recommendedSalesForBusinessType(value)
      }
      // El modo sigue saliendo del TIPO al crear. Ya no hay selector que lo
      // pueda «tocar», así que la recomendación se aplica siempre al alta.
      if (k === 'type' && !id) {
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
        chat_mode: id ? prev.chat_mode : recommendedChatModeForBusinessType(type),
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

  // ⚠️ Aquí vivían `requestVerification` y `verify`, que comprobaban las
  // credenciales del canal PROPIO de un negocio. Se van con el bloque que las
  // llamaba: sin canal propio no hay nada que verificar — el verificador
  // consultaría una cuenta que no existe.
  //
  // El botón de verificar el número del MARKETPLACE es otro y sigue vivo, en
  // Ajustes del servidor (`/api/admin/verify-platform-channel`).

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    // ⚠️ SIEMPRE. Desde el 2026-08-23 ningún local tiene canal propio: no hay
    // pantalla para dárselo y la base lo impediría con el número de la
    // plataforma. Se deja explícito en vez de leer el guardado para que un
    // negocio que venga de la etapa anterior quede convertido al editarlo, en
    // vez de conservar en silencio un número que secuestraría el enrutado.
    const sinCanalPropio = true
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
      whatsapp_provider: 'marketplace' as BusinessPayload['whatsapp_provider'],
      ycloud_number: sinCanalPropio ? null : (f.whatsapp_number.trim() || null),
      ycloud_webhook_endpoint_id: sinCanalPropio ? null : (f.ycloud_webhook_endpoint_id.trim() || null),
      meta_phone_id: sinCanalPropio ? null : (f.meta_phone_id || null),
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
    // ⚠️ Aquí se verificaban las credenciales del canal antes de guardar, y el
    // bloque entero murió el 2026-08-23: sin canal propio no hay credenciales
    // que verificar, así que la condición nunca se cumplía. Se retira en vez
    // de dejarla como rama inalcanzable — que es justo el tipo de código que
    // luego nadie sabe si está vivo.
    //
    // ⚠️ Y este bloque tiene historia: en su día verificaba para TODO proveedor
    // que no fuera Telegram, así que el alta de un local de marketplace moría
    // con «Proveedor no reconocido» — con las pruebas y los verificadores en
    // verde, porque ninguno pasa por el panel.
    try {
      if (id) await adm.updateClient(id, payload)
      else await adm.createClient(payload)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar')
    } finally { setSaving(false) }
  }

  /**
   * ¿Este local sale en el menú de Umbani?
   *
   * DERIVADO de los dos campos que ya existían, no un campo nuevo: el payload
   * sigue mandando exactamente `takes_orders` y `storefront_enabled`. Lo que
   * cambia es que ya no se pueden poner en desacuerdo desde la pantalla, que
   * era el estado en el que un local «vendía» sin que ningún cliente pudiera
   * encontrarlo.
   *
   * Las condiciones son las mismas que aplica `marketplace_categories_disponibles`
   * en la base. `active` y `suspended` no entran aquí: se manejan con Suspender
   * y Reactivar, no editando la ficha.
   */
  const enMarketplace = f.sales !== 'informa' && f.storefront === 'yes'

  const setEnMarketplace = (value: string) => {
    const visible = value === 'si'
    setSalesTouched(true)
    setStorefrontTouched(true)
    setF(prev => ({
      ...prev,
      sales: visible ? 'vende' : 'informa',
      storefront: visible ? 'yes' : 'no',
      // ⚠️ `chat_mode` viaja con la decisión, y no es un capricho: el servidor
      // rechaza `miniapp` sin pedidos ni tienda (`miniappConfigurationError`),
      // así que ocultar un local con `chat_mode = 'miniapp'` guardado —el caso
      // de producción— fallaría con «El modo miniapp requiere que el negocio
      // cree pedidos». Dentro del marketplace la columna no decide nada: la
      // experiencia la elige el TIPO del local al entrar en él. Se mueve para
      // que el guardado no choque con un invariante de un modo que ya no
      // gobierna a nadie.
      chat_mode: visible ? prev.chat_mode : 'menu',
    }))
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
              {/* El negocio del marketplace se atiende por el número de la
                  plataforma, así que no tiene uno propio que pedirle. El campo
                  se oculta en vez de quedarse vacío: la base lo rechazaría. */}
              {f.whatsapp_provider !== 'marketplace' && (
                <div><Label htmlFor="client-whatsapp-number">WhatsApp del negocio *</Label><Input id="client-whatsapp-number" value={f.whatsapp_number} onChange={set('whatsapp_number')} placeholder="+593…" /></div>
              )}
              <div><Label htmlFor="client-owner-phone">WhatsApp del dueño (reportes){f.whatsapp_provider === 'marketplace' ? ' *' : ''}</Label><Input id="client-owner-phone" value={f.owner_phone} onChange={set('owner_phone')} placeholder="+593… (solo él pide reportes)" /></div>
            </div>

            {/* ⚠️ UNA decisión, no dos — cambiado el 2026-08-23.
                Aquí había dos desplegables, «Ventas por el bot»
                (`takes_orders`) y «Mini app de la tienda»
                (`storefront_enabled`), y la base exige LOS DOS para que un
                local salga en el menú (`marketplace_categories_disponibles`).
                Eso abría un estado trampa —crea pedidos pero sin tienda— en el
                que el local quedaba invisible en el marketplace sin que nada
                lo dijera: el superadmin lo veía «vendiendo» y ningún cliente
                podía encontrarlo.

                Los nombres tampoco valían ya: hablaban de un bot que informa y
                deriva, y de un bot que manda su enlace. Ese bot por local no
                existe desde que se retiró la IA y el canal propio; quien manda
                el enlace es el menú de Umbani.

                Las DOS columnas se siguen enviando en el payload, con el mismo
                valor. Ninguna se retira. */}
            {id ? (
            <div className="mb-4 rounded-lg border border-border/70 p-3">
              <Label htmlFor="client-marketplace">Aparece en el marketplace</Label>
              <Select value={enMarketplace ? 'si' : 'no'} onValueChange={setEnMarketplace}>
                <SelectTrigger id="client-marketplace" className="mt-1 w-full sm:max-w-md"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="si">Sí — sale en el menú y recibe pedidos</SelectItem>
                  <SelectItem value="no">No — queda oculto para los clientes</SelectItem>
                </SelectContent>
              </Select>
              <p className="mt-2 text-xs text-muted-foreground" data-testid="client-marketplace-help">
                {enMarketplace
                  ? 'Quien escriba al número de Umbani lo encontrará en su categoría y recibirá el enlace de su tienda. Enciéndelo con el catálogo ya cargado: una tienda vacía se ve peor que ninguna.'
                  : 'No aparece en ninguna categoría del menú y su tienda no acepta pedidos. Úsalo mientras se carga el catálogo; el negocio y sus datos siguen intactos.'}
              </p>
            </div>
            ) : (
              <div className="mb-4 rounded-lg border border-border/70 p-3">
                <p className="text-sm text-foreground" data-testid="client-mode-summary">
                  {chatModeSummary(f.type)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Lo decide el tipo de negocio. Se puede cambiar después, al editarlo.
                </p>
              </div>
            )}

            {/* Canal WhatsApp — ⚠️ Solo al EDITAR.
                Un local NACE en el marketplace: se atiende por el número de
                la plataforma y no tiene credenciales que pedir ni verificar.
                Un negocio con número propio es hoy el caso raro —queda uno en
                producción y ya existe—, así que se configura aquí, al editar,
                en vez de gastar siete campos del alta en algo que casi nadie
                rellena. Nada se pierde: todo esto sigue vivo e intacto. */}
            {/* ⚠️ SE RETIRÓ EL CANAL PROPIO el 2026-08-23, y nace de un fallo
                real: Monster Pizza tenía el MISMO número que la plataforma,
                así que `resolveBusinessChannel` la encontraba antes de llegar
                a la rama del marketplace y escribir al número de Umbani
                contestaba con su mini app en vez de las categorías. Todo lo
                construido para el número único era inalcanzable.

                Aquí vivían siete campos —proveedor, API Key, Endpoint ID,
                Signing Secret, token y Phone ID de Meta, token de Telegram— y
                un botón de verificar. Ninguno tiene sentido ya: los locales se
                atienden por el número del marketplace y no tienen cuenta
                propia que configurar.

                ⚠️ La defensa de verdad NO es esta pantalla, es el disparador
                `businesses_numero_de_plataforma` en la base: quitar el campo
                evita el error de dedo, pero solo la guarda impide que el
                número vuelva a entrar por una API o un `update` a mano. */}
            {id && (
            <div className="rounded-xl border p-4 mb-4">
              <span className="inline-flex items-center gap-1.5 text-sm font-medium">
                <RadioTower className="w-4 h-4" /> Canal de WhatsApp
              </span>
              <p className="mt-2 text-xs text-muted-foreground">
                Este local se atiende por el <strong>número del marketplace</strong>.
                No tiene número propio, ni cuenta de YCloud, ni webhook: sus clientes
                escriben al número de Umbani y el menú los lleva hasta su tienda.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                El número del marketplace se configura una sola vez en{' '}
                <strong>Ajustes del servidor → Número del marketplace</strong>.
              </p>
            </div>
            )}

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
                      // Solo el precio: los cupos se siguen guardando y
                      // Medición alerta los excesos, pero al dar de alta lo
                      // único que se pacta con el negocio es la mensualidad.
                      <SelectItem key={plan.id} value={plan.id}>
                        {plan.label} — ${plan.monthlyRate}/mes
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {/* ⚠️ Eran tres inputs `readOnly`: tres campos que ocupaban
                  media pantalla y que nadie podía tocar, porque los tres
                  salen del plan elegido arriba. Como resumen dicen lo mismo
                  ocupando una línea. El payload no cambia: se siguen enviando
                  los mismos valores. */}
              <div className="self-end text-sm text-muted-foreground" data-testid="client-plan-summary">
                {planById(f.plan)
                  ? <strong className="text-foreground">${f.monthly_rate}/mes</strong>
                  : 'Selecciona un plan'}
              </div>
              </div>
              <p id="client-plan-help" className="mt-3 text-xs text-muted-foreground">
                La tarifa pertenece al plan seleccionado. Cada mes se crea una sola cuota automáticamente; la suspensión por falta de pago continúa siendo manual.
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

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import * as adm from './api'
import { enElMarketplace, type BusinessRow } from './api'
import { toast } from 'sonner'
import { Button } from '@botpanel/ui/components/button'
import { Textarea } from '@botpanel/ui/components/textarea'
import { Smartphone, Bot as BotIcon, TriangleAlert } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@botpanel/ui/components/dialog'
import { planLabel } from './plans'

// ── Herramientas por negocio (paridad con el admin viejo):
// 👁 Ver negocio (datos + estadísticas + últimas conversaciones)
// 🤖 Prompt del Bot por negocio (con plantillas formal/casual/luxury)

export function ViewModal({ c, onClose }: { c: BusinessRow; onClose: () => void }) {
  const { data: prods = [] } = useQuery({ queryKey: ['adm-cprods', c.id], queryFn: () => adm.getClientProducts(c.id) })
  const { data: convs = [] } = useQuery({ queryKey: ['adm-cconvs', c.id], queryFn: () => adm.getClientConversations(c.id) })
  const { data: pol } = useQuery({ queryKey: ['adm-cpol', c.id], queryFn: () => adm.getClientPolicies(c.id) })

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader className="mb-4">
          <DialogTitle>{c.name}</DialogTitle>
          <DialogDescription>Resumen operativo y configuración actual del negocio.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 mb-4 sm:grid-cols-2">
          <div className="rounded-xl bg-muted/60 p-4 text-sm text-foreground/80 space-y-1">
            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Negocio</div>
            <div><strong className="text-foreground/90">Tipo:</strong> {c.type || '—'}</div>
            {/* ⚠️ Era «Número», y estaba vacío en todos: un local del
                marketplace no puede tener número propio —la base se lo
                prohíbe— y se atiende por el de Umbani. Lo que lo identifica
                es su tienda. */}
            <div><strong className="text-foreground/90">Tienda:</strong> /t/{c.slug}</div>
            <div><strong className="text-foreground/90">Plan:</strong> {planLabel(c.plan)}</div>
            <div><strong className="text-foreground/90">Estado:</strong> {c.suspended ? 'Suspendido' : 'Activo'}</div>
            <div>
              <strong className="text-foreground/90">Marketplace:</strong>{' '}
              {enElMarketplace(c) ? 'Visible en el menú' : 'Oculto'}
            </div>
          </div>
          <div className="rounded-xl bg-muted/60 p-4 text-sm text-foreground/80 space-y-1">
            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Estadísticas</div>
            <div><strong className="text-foreground/90">Productos:</strong> {prods.length}</div>
            <div><strong className="text-foreground/90">Conversaciones:</strong> {convs.length}</div>
            <div><strong className="text-foreground/90">Envíos:</strong> {pol?.shipping ? 'Configurado' : 'Sin configurar'}</div>
          </div>
        </div>
        {/* ⚠️ Estas son las conversaciones del CANAL PROPIO
            (`conversation_history`). Un local del marketplace no escribe ahí:
            su conversación con el cliente vive en `marketplace_conversations`
            hasta que se le entrega el enlace de la tienda. Decirlo evita leer
            «sin mensajes» como «nadie le escribe». */}
        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
          Conversaciones por canal propio
        </div>
        <div className="max-h-64 overflow-y-auto space-y-2">
          {convs.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Sin mensajes por canal propio. Los clientes de este local escriben al número
              de Umbani y sus pedidos se ven en el panel del negocio.
            </p>
          )}
          {convs.slice(0, 20).map((m, i) => (
            <div key={i} className="rounded-lg bg-muted/40 px-3 py-2 text-sm">
              <div className={`text-[11px] font-semibold mb-0.5 flex items-center gap-1 ${m.role === 'user' ? 'text-blue-600 dark:text-blue-400' : 'text-primary'}`}>
                {m.role === 'user' ? <><Smartphone className="w-3 h-3" /> {m.contact_phone}</> : <><BotIcon className="w-3 h-3" /> Bot</>}
              </div>
              <div className="text-foreground/80 whitespace-pre-wrap wrap-anywhere">{(m.content || '').slice(0, 300)}</div>
            </div>
          ))}
        </div>
        <DialogFooter className="mx-0 mb-0 mt-4 px-0 pb-0">
          <Button variant="outline" onClick={onClose}>Cerrar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Mismas plantillas del admin viejo

export function BienvenidaModal({ c, onClose }: { c: BusinessRow; onClose: () => void }) {
  const [saludo, setSaludo] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    adm.getClientPolicies(c.id).then(d => setSaludo(d.welcome_message || '')).catch(() => {})
  }, [c.id])

  async function save() {
    setSaving(true)
    try {
      await adm.saveClientPolicies(c.id, { welcome_message: saludo.trim() || null })
      toast.success('Saludo guardado')
      setTimeout(onClose, 800)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error') }
    setSaving(false)
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Mensaje de bienvenida</DialogTitle>
          <DialogDescription>Lo primero que lee el cliente. Se manda tal cual.</DialogDescription>
          <p className="text-sm text-muted-foreground">{c.name}</p>
        </DialogHeader>
        <Textarea
          id="client-welcome-message"
          aria-label="Mensaje de bienvenida"
          value={saludo}
          onChange={e => setSaludo(e.target.value)}
          rows={3}
          maxLength={280}
          className="w-full"
          placeholder="¡Hola! 👋 Bienvenido a {{negocio}}. ¿Qué se te antoja hoy?"
        />
        <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1">
          <TriangleAlert className="w-3 h-3 shrink-0" />
          {280 - saludo.length} caracteres disponibles. Vacío = saludo estándar con el nombre del negocio.
        </p>
        <DialogFooter className="mx-0 mb-0 mt-3 px-0 pb-0">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar saludo'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

import { useMemo, useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import * as convApi from './api'
import { session } from '../../api/client'
import { MessageSquare, RotateCw, HandCoins, Tag as TagIcon, Pencil, Hand, Bot as BotIcon, X, Trash2 } from 'lucide-react'
import type { Session, Msg, Tag } from './api'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Badge } from '@botpanel/ui/components/badge'
import { Input } from '@botpanel/ui/components/input'
import { Checkbox } from '@botpanel/ui/components/checkbox'
import { Label } from '@botpanel/ui/components/label'
import { ConfirmAction } from '@botpanel/ui/components/confirm-action'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@botpanel/ui/components/dialog'
import { QueryError } from '@botpanel/ui/components/query-error'
import { toast } from 'sonner'

// Polling con la optimización de egress documentada en CLAUDE.md §11:
// cada 10s (no 3s) y TanStack Query lo PAUSA solo cuando la pestaña
// no está visible (refetchIntervalInBackground: false por defecto).
const POLL_MS = 10_000
const EMPTY_SESSIONS: Session[] = []
const EMPTY_MESSAGES: Msg[] = []
const EMPTY_TAGS: Tag[] = []

// Colores predefinidos de etiquetas (mismos del panel viejo)
const TAG_COLORS = ['#ef5350','#ff9800','#ffd54f','#66bb6a','#26a69a','#42a5f5','#5c6bc0','#ab47bc','#ec407a','#78909c']

const fmtTime = (iso: string) => {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('es-EC', { day: '2-digit', month: 'short' })
}

export default function Conversations() {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [tagsOpen, setTagsOpen] = useState(false)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const openedFromUrl = useRef(false)
  const user = session.user
  const canVentas = user?.role === 'owner' || (user?.permissions ?? []).includes('ventas')

  const sessionsQuery = useQuery({ queryKey: ['sessions'], queryFn: convApi.getSessions, refetchInterval: POLL_MS })
  const messagesQuery = useQuery({ queryKey: ['conversations'], queryFn: convApi.getConversations, refetchInterval: POLL_MS })
  const tagsQuery = useQuery({ queryKey: ['tags'], queryFn: convApi.getTags })
  const sessions = sessionsQuery.data ?? EMPTY_SESSIONS
  const msgs = messagesQuery.data ?? EMPTY_MESSAGES
  const tags = tagsQuery.data ?? EMPTY_TAGS
  const loadError = sessionsQuery.isError || messagesQuery.isError || tagsQuery.isError

  const refresh = () => { qc.invalidateQueries({ queryKey: ['sessions'] }); qc.invalidateQueries({ queryKey: ['conversations'] }) }

  const mMode   = useMutation({
    mutationFn: (v: { phone: string; manual: boolean }) => convApi.setMode(v.phone, v.manual),
    onSuccess: (_data, v) => {
      // Los reportes valen lo que valga el registro: al reactivar el bot tras
      // atender a mano, recordar registrar la venta si la hubo. Solo aplica a
      // conversaciones vivas (último mensaje < 24 h): un chat dormido hace
      // semanas no tiene una venta recién cerrada que registrar.
      const lastAt = sessions.find(s => s.contact_phone === v.phone)?.last_message_at
      const isRecent = Boolean(lastAt) && Date.now() - new Date(lastAt!).getTime() < 24 * 60 * 60 * 1000
      if (!v.manual && isRecent) {
        toast('¿Cerraste una venta con este cliente?', {
          description: 'Regístrala para que tus reportes queden al día.',
          action: {
            label: 'Registrar venta',
            onClick: () => navigate(`/sales?phone=${encodeURIComponent(v.phone)}`),
          },
          duration: 10_000,
        })
      }
    },
    onSettled: refresh,
  })
  const mRead   = useMutation({ mutationFn: (phone: string) => convApi.markRead(phone), onSettled: refresh })
  const mRename = useMutation({ mutationFn: (v: { phone: string; name: string }) => convApi.renameContact(v.phone, v.name), onSettled: refresh })
  const mTags   = useMutation({ mutationFn: (v: { phone: string; tags: string[] }) => convApi.setSessionTags(v.phone, v.tags), onSettled: refresh })
  const mSend   = useMutation({ mutationFn: (v: { phone: string; message: string }) => convApi.sendMessage(v.phone, v.message), onSettled: refresh })

  useEffect(() => {
    if (openedFromUrl.current) return
    const requestedPhone = searchParams.get('phone')
    if (!requestedPhone || sessions.length === 0) return
    const requestedSession = sessions.find(item => item.contact_phone === requestedPhone)
    if (!requestedSession) return
    openedFromUrl.current = true
    setSelected(requestedPhone)
    if (requestedSession.unread_owner) mRead.mutate(requestedPhone)
  }, [mRead, searchParams, sessions])

  // Mensajes agrupados por contacto (el endpoint trae los últimos 100 mezclados)
  const byPhone = useMemo(() => {
    const map = new Map<string, Msg[]>()
    for (const m of [...msgs].reverse()) {
      if (!map.has(m.contact_phone)) map.set(m.contact_phone, [])
      map.get(m.contact_phone)!.push(m)
    }
    return map
  }, [msgs])

  const sess = sessions.find(s => s.contact_phone === selected) || null
  const chat = selected ? (byPhone.get(selected) ?? []) : []
  const tagById = useMemo(() => new Map(tags.map(t => [t.id, t])), [tags])

  // Autoscroll al final del chat
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [chat.length, selected])

  function openChat(s: Session) {
    setSelected(s.contact_phone)
    setRenaming(false); setTagsOpen(false)
    if (s.unread_owner) mRead.mutate(s.contact_phone)
  }

  function send() {
    const text = draft.trim()
    if (!text || !selected) return
    setDraft('')
    mSend.mutate({ phone: selected, message: text })
  }

  if (loadError) {
    return <QueryError onRetry={() => {
      void Promise.all([
        sessionsQuery.refetch(),
        messagesQuery.refetch(),
        tagsQuery.refetch(),
      ])
    }} />
  }

  return (
    <div className="flex h-auto flex-col gap-4 lg:h-[calc(100vh-3rem)] lg:flex-row">
      {/* Lista de conversaciones */}
      <Card className="h-72 w-full shrink-0 gap-0 overflow-hidden py-0 lg:h-auto lg:w-80">
        <div className="px-4 py-3 border-b border-border/60 flex items-center justify-between">
          <span className="font-semibold text-foreground inline-flex items-center gap-2"><MessageSquare className="w-4 h-4" /> Conversaciones</span>
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse motion-reduce:animate-none" title="Actualizando en tiempo real" />
            <Button variant="ghost" size="icon-sm" onClick={refresh} aria-label="Actualizar conversaciones" title="Actualizar"><RotateCw /></Button>
          </span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sessions.length === 0 && <p className="p-4 text-sm text-muted-foreground">Aún no hay conversaciones.</p>}
          {sessions.map(s => (
            <Button
              variant="ghost"
              key={s.contact_phone} onClick={() => openChat(s)}
              className={`w-full h-auto flex-col items-stretch gap-0 whitespace-normal rounded-none text-left px-4 py-3 border-b border-border/40 hover:bg-muted/50 transition-colors ${s.manual_mode ? 'border-l-2 border-l-amber-500' : ''} ${selected === s.contact_phone ? 'bg-primary/10' : s.manual_mode ? 'bg-amber-500/10 hover:bg-amber-500/15' : ''}`}
            >
              <div className="flex w-full min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 font-medium text-sm text-foreground truncate">
                  {s.unread_owner && <span className="inline-block w-2 h-2 rounded-full bg-red-500 mr-1.5 animate-pulse motion-reduce:animate-none" />}
                  {s.contact_name || s.contact_phone}
                </span>
                <span className="text-[11px] text-muted-foreground/80 shrink-0">{fmtTime(s.last_message_at)}</span>
              </div>
              <div className="flex w-full min-w-0 items-center gap-1 mt-0.5">
                {s.manual_mode
                  ? <Badge variant="secondary" className="text-[10px] px-1.5 gap-0.5 shrink-0 text-amber-700 bg-amber-50 dark:bg-amber-500/10 dark:text-amber-300"><Hand className="w-3 h-3" />MANUAL</Badge>
                  : <Badge variant="secondary" className="text-[10px] px-1.5 gap-0.5 shrink-0 text-primary bg-primary/10"><BotIcon className="w-3 h-3" />BOT</Badge>}
                <span className="min-w-0 flex-1 text-xs text-muted-foreground truncate">{s.last_message || ''}</span>
              </div>
              {(s.tags ?? []).length > 0 && (
                <div className="flex gap-1 mt-1 flex-wrap">
                  {(s.tags ?? []).map(id => {
                    const t = tagById.get(id)
                    return t ? <span key={id} className="text-[10px] rounded-full px-2 py-0.5 text-white font-medium" style={{ backgroundColor: t.color }}>{t.name}</span> : null
                  })}
                </div>
              )}
            </Button>
          ))}
        </div>
      </Card>

      {/* Chat */}
      <Card className="min-h-[28rem] min-w-0 flex-1 gap-0 overflow-hidden py-0 lg:min-h-0">
        {!sess ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground/80 text-sm">Elige una conversación para verla aquí</div>
        ) : (
          <>
            {/* Encabezado del chat */}
            <div className="px-4 py-3 border-b border-border/60 flex items-center gap-3 flex-wrap">
              <div className="min-w-0">
                <Button variant="link" onClick={() => { setNameDraft(sess.contact_name || ''); setRenaming(true) }} title="Editar nombre"
                  className="h-auto p-0 font-semibold text-foreground truncate">
                  {sess.contact_name || sess.contact_phone} <Pencil className="w-3 h-3 inline text-muted-foreground/50" />
                </Button>
                <div className="text-xs text-muted-foreground/80">
                  {sess.contact_phone.replace('tg_', 'Telegram ')} · {sess.manual_mode
                    ? <span className="font-medium text-amber-700 dark:text-amber-300">Modo manual — respondiendo tú</span>
                    : 'Bot activo'}
                </div>
              </div>

              <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
                {/* Venta realizada (abre el modal de venta, como el viejo) */}
                {canVentas && (
                  <Button size="sm" onClick={() => navigate(`/sales?phone=${encodeURIComponent(sess.contact_phone)}`)}>
                    <span className="inline-flex items-center gap-1.5"><HandCoins className="w-4 h-4" /> Venta realizada</span>
                  </Button>
                )}

                {/* Etiquetas (abre modal) */}
                <Button variant="outline" size="sm" onClick={() => setTagsOpen(true)}><TagIcon className="w-4 h-4" /> Etiquetas</Button>

                {/* Nombre */}
                <Button variant="outline" size="sm" onClick={() => { setNameDraft(sess.contact_name || ''); setRenaming(true) }}><span className="inline-flex items-center gap-1.5"><Pencil className="w-4 h-4" /> Nombre</span></Button>

                {/* Tomar control / Activar bot (labels del viejo) */}
                {sess.manual_mode ? (
                  <Button variant="outline" size="sm" className="border-amber-500/60 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200" onClick={() => mMode.mutate({ phone: sess.contact_phone, manual: false })}>
                    <span className="inline-flex items-center gap-1.5"><Hand className="w-4 h-4" /> Devolver al bot</span>
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => mMode.mutate({ phone: sess.contact_phone, manual: true })}>
                    <span className="inline-flex items-center gap-1.5"><Hand className="w-4 h-4" /> Tomar control</span>
                  </Button>
                )}
              </div>
            </div>

            {/* Mensajes */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-muted/50">
              {chat.length === 0 && <p className="text-sm text-muted-foreground/80 text-center mt-8">Sin mensajes recientes (se muestran los últimos 100 del negocio).</p>}
              {chat.map((m, i) => (
                <div key={i} className={`flex ${m.role === 'user' ? 'justify-start' : 'justify-end'}`}>
                  <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap wrap-anywhere ${
                    m.role === 'user' ? 'bg-card border text-foreground'
                    : m.role === 'owner' ? 'bg-blue-600 text-white'
                    : 'bg-primary text-primary-foreground'
                  }`}>
                    {m.role === 'owner' && <div className="text-[10px] opacity-80 mb-0.5">Tú (manual)</div>}
                    {m.role === 'assistant' && <div className="text-[10px] opacity-80 mb-0.5 flex items-center gap-1"><BotIcon className="w-3 h-3" /> Bot</div>}
                    {m.content}
                    <div className={`text-[10px] mt-1 ${m.role === 'user' ? 'text-muted-foreground/80' : 'opacity-70'}`}>{fmtTime(m.created_at)}</div>
                  </div>
                </div>
              ))}
              <div ref={endRef} />
            </div>

            {/* Enviar — SOLO en modo manual, como el viejo */}
            {sess.manual_mode && (
            <form onSubmit={e => { e.preventDefault(); send() }} className="p-3 border-t border-border/60 flex gap-2">
              <Input
                id="conversation-manual-message"
                aria-label="Mensaje manual"
                value={draft} onChange={e => setDraft(e.target.value)}
                placeholder="Escribe como dueño del negocio..." className="flex-1"
              />
              <Button disabled={!draft.trim() || mSend.isPending}>
                Enviar
              </Button>
            </form>
            )}

            {/* Modal: editar nombre del contacto */}
            <Dialog open={renaming} onOpenChange={open => { if (!open) setRenaming(false) }}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Editar nombre del contacto</DialogTitle>
                  <DialogDescription>El nombre es solo para tu panel; tu cliente no lo ve.</DialogDescription>
                </DialogHeader>
                <form onSubmit={e => { e.preventDefault(); mRename.mutate({ phone: sess.contact_phone, name: nameDraft }); setRenaming(false) }} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="conversation-contact-name">Nombre del contacto</Label>
                    <Input id="conversation-contact-name" autoFocus value={nameDraft} onChange={e => setNameDraft(e.target.value)} placeholder={sess.contact_phone} />
                  </div>
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setRenaming(false)}>Cancelar</Button>
                    <Button type="submit" disabled={mRename.isPending}>Guardar</Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>

            {/* Modal: etiquetas del chat */}
            <Dialog open={tagsOpen} onOpenChange={setTagsOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Etiquetas del chat</DialogTitle>
                  <DialogDescription>Marca las de esta conversación; crea, edita o elimina las de tu negocio.</DialogDescription>
                </DialogHeader>
                <TagPicker
                  tags={tags} selected={sess.tags ?? []}
                  onToggle={(id) => {
                    const cur = new Set(sess.tags ?? [])
                    if (cur.has(id)) cur.delete(id); else cur.add(id)
                    mTags.mutate({ phone: sess.contact_phone, tags: [...cur] })
                  }}
                  onCreate={async (name, color) => { await convApi.createTag(name, color); qc.invalidateQueries({ queryKey: ['tags'] }) }}
                  onUpdate={async (id, name, color) => { await convApi.updateTag(id, name, color); qc.invalidateQueries({ queryKey: ['tags'] }) }}
                  onDelete={async (id) => { await convApi.deleteTag(id); qc.invalidateQueries({ queryKey: ['tags'] }); refresh() }}
                />
              </DialogContent>
            </Dialog>

          </>
        )}
      </Card>
    </div>
  )
}

// Contenido del modal de etiquetas: asignar existentes + crear nueva con color
function TagPicker({ tags, selected, onToggle, onCreate, onUpdate, onDelete }: {
  tags: Tag[]; selected: string[]
  onToggle: (id: string) => void
  onCreate: (name: string, color: string) => Promise<void>
  onUpdate: (id: string, name: string, color: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(TAG_COLORS[0])
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<Tag | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState(TAG_COLORS[0])

  return (
    <div>
      <div className="space-y-1 max-h-64 overflow-y-auto mb-3">
        {tags.length === 0 && <p className="text-xs text-muted-foreground">Aún no tienes etiquetas — crea la primera abajo.</p>}
        {tags.map(t => editing?.id === t.id ? (
          <form key={t.id} className="rounded border border-border p-2"
            onSubmit={async e => { e.preventDefault(); await onUpdate(t.id, editName.trim() || t.name, editColor); setEditing(null) }}>
            <Input id={`tag-${t.id}-name`} aria-label={`Nombre de la etiqueta ${t.name}`} autoFocus value={editName} onChange={e => setEditName(e.target.value)} className="w-full mb-1.5" />
            <div className="flex gap-1 mb-1.5 flex-wrap">
              {TAG_COLORS.map(c => (
                <Button key={c} type="button" variant="ghost" size="icon-xs" aria-label={`Color ${c}`} aria-pressed={editColor === c} onClick={() => setEditColor(c)}
                  className={`size-4 rounded-full p-0 border-2 ${editColor === c ? 'border-foreground' : 'border-transparent'}`}
                  style={{ backgroundColor: c }} />
              ))}
            </div>
            <div className="flex gap-1">
              <Button variant="ghost" size="sm" className="flex-1">Guardar</Button>
              <Button variant="outline" size="icon-sm" type="button" onClick={() => setEditing(null)} aria-label="Cancelar edición"><X /></Button>
            </div>
          </form>
        ) : (
          <div key={t.id} className="flex items-center gap-2 text-sm rounded px-1 py-0.5 hover:bg-muted/50 group">
            <Checkbox id={`tag-${t.id}-selected`} checked={selected.includes(t.id)} onCheckedChange={() => onToggle(t.id)} className="cursor-pointer" />
            <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: t.color }} />
            <Label htmlFor={`tag-${t.id}-selected`} className="mb-0 flex-1 truncate text-foreground/90 font-normal leading-5 cursor-pointer">{t.name}</Label>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Editar etiqueta" title="Editar etiqueta" className="opacity-100 text-muted-foreground hover:text-foreground md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
              onClick={() => { setEditing(t); setEditName(t.name); setEditColor(t.color) }}><Pencil className="w-3.5 h-3.5" /></Button>
            <ConfirmAction
              trigger={<Button type="button" variant="ghost" size="icon-xs" aria-label="Eliminar etiqueta" title="Eliminar etiqueta" className="opacity-100 text-muted-foreground hover:text-destructive md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"><Trash2 className="w-3.5 h-3.5" /></Button>}
              title={`Eliminar etiqueta “${t.name}”`}
              description="La etiqueta se quitará de todos los chats. Esta acción no se puede deshacer."
              confirmLabel="Eliminar"
              destructive
              onConfirm={() => onDelete(t.id)}
            />
          </div>
        ))}
      </div>
      <form
        onSubmit={async e => {
          e.preventDefault()
          if (!name.trim()) return
          setSaving(true)
          try { await onCreate(name.trim(), color); setName('') } finally { setSaving(false) }
        }}
        className="border-t border-border/60 pt-2"
      >
        <Input id="new-tag-name" aria-label="Nueva etiqueta" value={name} onChange={e => setName(e.target.value)} placeholder="Nueva etiqueta…" className="w-full mb-2" />
        <div className="flex gap-1 mb-2 flex-wrap">
          {TAG_COLORS.map(c => (
            <Button key={c} type="button" variant="ghost" size="icon-xs" aria-label={`Color ${c}`} aria-pressed={color === c} onClick={() => setColor(c)}
              className={`size-5 rounded-full p-0 border-2 ${color === c ? 'border-foreground' : 'border-transparent'}`}
              style={{ backgroundColor: c }} />
          ))}
        </div>
        <Button variant="ghost" size="sm" disabled={!name.trim() || saving} className="w-full">
          {saving ? 'Creando…' : '+ Crear etiqueta'}
        </Button>
      </form>
    </div>
  )
}

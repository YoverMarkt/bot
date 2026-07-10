import { useMemo, useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import * as convApi from './api'
import { session } from '../../api/client'
import type { Session, Msg, Tag } from './api'

// Polling con la optimización de egress documentada en CLAUDE.md §11:
// cada 10s (no 3s) y TanStack Query lo PAUSA solo cuando la pestaña
// no está visible (refetchIntervalInBackground: false por defecto).
const POLL_MS = 10_000

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
  const user = session.user
  const canVentas = user?.role === 'owner' || (user?.permissions ?? []).includes('ventas')

  const { data: sessions = [] } = useQuery({ queryKey: ['sessions'], queryFn: convApi.getSessions, refetchInterval: POLL_MS })
  const { data: msgs = [] }     = useQuery({ queryKey: ['conversations'], queryFn: convApi.getConversations, refetchInterval: POLL_MS })
  const { data: tags = [] }     = useQuery({ queryKey: ['tags'], queryFn: convApi.getTags })

  const refresh = () => { qc.invalidateQueries({ queryKey: ['sessions'] }); qc.invalidateQueries({ queryKey: ['conversations'] }) }

  const mMode   = useMutation({ mutationFn: (v: { phone: string; manual: boolean }) => convApi.setMode(v.phone, v.manual), onSettled: refresh })
  const mRead   = useMutation({ mutationFn: (phone: string) => convApi.markRead(phone), onSettled: refresh })
  const mRename = useMutation({ mutationFn: (v: { phone: string; name: string }) => convApi.renameContact(v.phone, v.name), onSettled: refresh })
  const mTags   = useMutation({ mutationFn: (v: { phone: string; tags: string[] }) => convApi.setSessionTags(v.phone, v.tags), onSettled: refresh })
  const mSend   = useMutation({ mutationFn: (v: { phone: string; message: string }) => convApi.sendMessage(v.phone, v.message), onSettled: refresh })

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

  return (
    <div className="h-[calc(100vh-3rem)] flex gap-4">
      {/* Lista de conversaciones */}
      <div className="w-80 shrink-0 bg-white rounded-xl border border-stone-200 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-stone-100 flex items-center justify-between">
          <span className="font-semibold text-stone-900">💬 Conversaciones</span>
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" title="Actualizando en tiempo real" />
            <button onClick={refresh} className="text-xs text-stone-500 hover:text-stone-800" title="Actualizar">↻</button>
          </span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sessions.length === 0 && <p className="p-4 text-sm text-stone-500">Aún no hay conversaciones.</p>}
          {sessions.map(s => (
            <button
              key={s.contact_phone} onClick={() => openChat(s)}
              className={`w-full text-left px-4 py-3 border-b border-stone-50 hover:bg-stone-50 transition-colors ${selected === s.contact_phone ? 'bg-green-50' : ''}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm text-stone-900 truncate">
                  {s.unread_owner && <span className="inline-block w-2 h-2 rounded-full bg-red-500 mr-1.5 animate-pulse" />}
                  {s.contact_name || s.contact_phone}
                </span>
                <span className="text-[11px] text-stone-400 shrink-0">{fmtTime(s.last_message_at)}</span>
              </div>
              <div className="flex items-center gap-1 mt-0.5">
                {s.manual_mode
                  ? <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 rounded px-1.5 py-0.5 shrink-0">🤚 MANUAL</span>
                  : <span className="text-[10px] font-semibold text-green-700 bg-green-50 rounded px-1.5 py-0.5 shrink-0">🤖 BOT</span>}
                <span className="text-xs text-stone-500 truncate">{s.last_message || ''}</span>
              </div>
              {(s.tags ?? []).length > 0 && (
                <div className="flex gap-1 mt-1 flex-wrap">
                  {(s.tags ?? []).map(id => {
                    const t = tagById.get(id)
                    return t ? <span key={id} className="text-[10px] rounded-full px-2 py-0.5 text-white font-medium" style={{ backgroundColor: t.color }}>{t.name}</span> : null
                  })}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Chat */}
      <div className="flex-1 min-w-0 bg-white rounded-xl border border-stone-200 flex flex-col overflow-hidden">
        {!sess ? (
          <div className="flex-1 flex items-center justify-center text-stone-400 text-sm">Elige una conversación para verla aquí</div>
        ) : (
          <>
            {/* Encabezado del chat */}
            <div className="px-4 py-3 border-b border-stone-100 flex items-center gap-3 flex-wrap">
              <div className="min-w-0">
                {renaming ? (
                  <form onSubmit={e => { e.preventDefault(); mRename.mutate({ phone: sess.contact_phone, name: nameDraft }); setRenaming(false) }} className="flex gap-1">
                    <input autoFocus value={nameDraft} onChange={e => setNameDraft(e.target.value)}
                      className="rounded border border-stone-300 px-2 py-1 text-sm w-44" placeholder="Nombre del contacto" />
                    <button className="text-sm text-green-700 font-semibold px-1">✓</button>
                    <button type="button" onClick={() => setRenaming(false)} className="text-sm text-stone-400 px-1">✕</button>
                  </form>
                ) : (
                  <button onClick={() => { setNameDraft(sess.contact_name || ''); setRenaming(true) }} title="Editar nombre"
                    className="font-semibold text-stone-900 truncate hover:underline">
                    {sess.contact_name || sess.contact_phone} <span className="text-stone-300 text-xs">✏️</span>
                  </button>
                )}
                <div className="text-xs text-stone-400">
                  {sess.contact_phone.replace('tg_', 'Telegram ')} · {sess.manual_mode ? '🤚 Modo manual — respondiendo tú' : '🤖 Bot activo'}
                </div>
              </div>

              <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
                {/* Venta realizada (abre el modal de venta, como el viejo) */}
                {canVentas && (
                  <button onClick={() => navigate(`/sales?phone=${encodeURIComponent(sess.contact_phone)}`)}
                    className="text-sm rounded-lg px-3 py-1.5 font-medium border border-green-300 text-green-800 hover:bg-green-50">
                    💰 Venta realizada
                  </button>
                )}

                {/* Etiquetas */}
                <div className="relative">
                  <button onClick={() => setTagsOpen(v => !v)} className="text-sm rounded-lg border border-stone-200 px-3 py-1.5 hover:bg-stone-50">🏷️ Etiquetas</button>
                  {tagsOpen && (
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
                      onClose={() => setTagsOpen(false)}
                    />
                  )}
                </div>

                {/* Nombre */}
                <button onClick={() => { setNameDraft(sess.contact_name || ''); setRenaming(true) }}
                  className="text-sm rounded-lg border border-stone-200 px-3 py-1.5 hover:bg-stone-50">✏️ Nombre</button>

                {/* Tomar control / Activar bot (labels del viejo) */}
                {sess.manual_mode ? (
                  <button onClick={() => mMode.mutate({ phone: sess.contact_phone, manual: false })}
                    className="text-sm rounded-lg px-3 py-1.5 font-medium border border-stone-200 hover:bg-stone-50">
                    🤖 Activar bot
                  </button>
                ) : (
                  <button onClick={() => mMode.mutate({ phone: sess.contact_phone, manual: true })}
                    className="text-sm rounded-lg px-3 py-1.5 font-medium border border-red-200 text-red-600 hover:bg-red-50">
                    🤚 Tomar control
                  </button>
                )}
              </div>
            </div>

            {/* Mensajes */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-stone-50">
              {chat.length === 0 && <p className="text-sm text-stone-400 text-center mt-8">Sin mensajes recientes (se muestran los últimos 100 del negocio).</p>}
              {chat.map((m, i) => (
                <div key={i} className={`flex ${m.role === 'user' ? 'justify-start' : 'justify-end'}`}>
                  <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words ${
                    m.role === 'user' ? 'bg-white border border-stone-200 text-stone-800'
                    : m.role === 'owner' ? 'bg-blue-600 text-white'
                    : 'bg-green-600 text-white'
                  }`}>
                    {m.role === 'owner' && <div className="text-[10px] opacity-80 mb-0.5">Tú (manual)</div>}
                    {m.role === 'assistant' && <div className="text-[10px] opacity-80 mb-0.5">🤖 Bot</div>}
                    {m.content}
                    <div className={`text-[10px] mt-1 ${m.role === 'user' ? 'text-stone-400' : 'opacity-70'}`}>{fmtTime(m.created_at)}</div>
                  </div>
                </div>
              ))}
              <div ref={endRef} />
            </div>

            {/* Enviar — SOLO en modo manual, como el viejo */}
            {sess.manual_mode && (
            <form onSubmit={e => { e.preventDefault(); send() }} className="p-3 border-t border-stone-100 flex gap-2">
              <input
                value={draft} onChange={e => setDraft(e.target.value)}
                placeholder="Escribe como dueño del negocio..." 
                className="flex-1 rounded-lg border border-stone-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              />
              <button disabled={!draft.trim() || mSend.isPending}
                className="rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold px-4 text-sm">
                Enviar
              </button>
            </form>
            )}

          </>
        )}
      </div>
    </div>
  )
}

// Popover de etiquetas: asignar existentes + crear nueva con color
function TagPicker({ tags, selected, onToggle, onCreate, onUpdate, onDelete, onClose }: {
  tags: Tag[]; selected: string[]
  onToggle: (id: string) => void
  onCreate: (name: string, color: string) => Promise<void>
  onUpdate: (id: string, name: string, color: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(TAG_COLORS[0])
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<Tag | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState(TAG_COLORS[0])

  return (
    <div className="absolute right-0 top-full mt-1 z-20 w-64 bg-white rounded-xl border border-stone-200 shadow-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-stone-900">Etiquetas del chat</span>
        <button onClick={onClose} className="text-stone-400 text-sm">✕</button>
      </div>
      <div className="space-y-1 max-h-40 overflow-y-auto mb-3">
        {tags.length === 0 && <p className="text-xs text-stone-500">Aún no tienes etiquetas — crea la primera abajo.</p>}
        {tags.map(t => editing?.id === t.id ? (
          <form key={t.id} className="rounded border border-stone-200 p-2"
            onSubmit={async e => { e.preventDefault(); await onUpdate(t.id, editName.trim() || t.name, editColor); setEditing(null) }}>
            <input autoFocus value={editName} onChange={e => setEditName(e.target.value)}
              className="w-full rounded border border-stone-300 px-2 py-1 text-sm mb-1.5" />
            <div className="flex gap-1 mb-1.5 flex-wrap">
              {TAG_COLORS.map(c => (
                <button key={c} type="button" onClick={() => setEditColor(c)}
                  className={`w-4 h-4 rounded-full border-2 ${editColor === c ? 'border-stone-800' : 'border-transparent'}`}
                  style={{ backgroundColor: c }} />
              ))}
            </div>
            <div className="flex gap-1">
              <button className="flex-1 rounded bg-stone-800 text-white text-xs py-1">Guardar</button>
              <button type="button" onClick={() => setEditing(null)} className="rounded border border-stone-200 text-xs px-2">✕</button>
            </div>
          </form>
        ) : (
          <div key={t.id} className="flex items-center gap-2 text-sm rounded px-1 py-0.5 hover:bg-stone-50 group">
            <input type="checkbox" checked={selected.includes(t.id)} onChange={() => onToggle(t.id)} className="cursor-pointer" />
            <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: t.color }} />
            <span className="text-stone-700 truncate flex-1">{t.name}</span>
            <button type="button" title="Editar etiqueta" className="opacity-0 group-hover:opacity-100 text-xs"
              onClick={() => { setEditing(t); setEditName(t.name); setEditColor(t.color) }}>✏️</button>
            <button type="button" title="Eliminar etiqueta (se quita de todos los chats)" className="opacity-0 group-hover:opacity-100 text-xs"
              onClick={() => { if (confirm(`¿Eliminar la etiqueta "${t.name}"? Se quita de todos los chats.`)) onDelete(t.id) }}>🗑</button>
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
        className="border-t border-stone-100 pt-2"
      >
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Nueva etiqueta…"
          className="w-full rounded border border-stone-300 px-2 py-1 text-sm mb-2" />
        <div className="flex gap-1 mb-2 flex-wrap">
          {TAG_COLORS.map(c => (
            <button key={c} type="button" onClick={() => setColor(c)}
              className={`w-5 h-5 rounded-full border-2 ${color === c ? 'border-stone-800' : 'border-transparent'}`}
              style={{ backgroundColor: c }} />
          ))}
        </div>
        <button disabled={!name.trim() || saving} className="w-full rounded bg-stone-800 text-white text-sm py-1.5 disabled:opacity-50">
          {saving ? 'Creando…' : '+ Crear etiqueta'}
        </button>
      </form>
    </div>
  )
}

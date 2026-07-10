import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, session } from '../../api/client'

// ── Tipos (endpoints de routes/business.routes.js) ──
type BusinessData = {
  name: string; slogan: string | null; description: string | null; hours: string | null
  address: string | null; phone: string | null; social: string | null; payment_methods: string | null
}
type Policies = { bot_prompt?: string | null; shipping?: string | null; returns?: string | null; discounts?: string | null; bot_instructions?: string | null }
type TeamUser = { id: string; email: string; name: string | null; role: string; permissions: string[] | null }

const input = 'w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500'

export default function Settings() {
  const isOwner = session.user?.role === 'owner'
  if (!isOwner) return <Locked />
  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-stone-900">Ajustes</h1>
        <p className="text-sm text-stone-500">Identidad básica de tu negocio</p>
      </div>
      <BusinessForm />
    </div>
  )
}

export function Locked() {
  return (
    <div className="bg-white rounded-xl border border-stone-200 p-8 text-center">
      <div className="text-3xl mb-2">🔒</div>
      <p className="text-stone-700 font-medium">Solo el dueño puede ver esta sección.</p>
    </div>
  )
}

// ── Identidad del negocio (Ajustes del viejo: SOLO nombre, slogan y descripción) ──
export function BusinessForm() {
  const { data, isLoading } = useQuery({ queryKey: ['business'], queryFn: () => api<BusinessData>('/api/client/business') })
  const [draft, setDraft] = useState<Partial<BusinessData> | null>(null)
  const [msg, setMsg] = useState('')
  const f = draft ?? data

  const mSave = useMutation({
    mutationFn: () => api('/api/client/business', { method: 'PUT', body: JSON.stringify({ name: f?.name, slogan: f?.slogan, description: f?.description }) }),
    onSuccess: () => setMsg('✅ Guardado — el bot ya usa estos datos'),
    onError: (e) => setMsg(`❌ ${e instanceof Error ? e.message : 'Error'}`),
  })

  if (isLoading || !f) return <p className="text-stone-500">Cargando…</p>
  const set = (k: keyof BusinessData) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setDraft({ ...f, [k]: e.target.value })

  return (
    <div className="bg-white rounded-xl border border-stone-200 p-5 max-w-xl">
      <div className="space-y-3">
        <div><label className="text-xs font-medium text-stone-600">Nombre del negocio</label><input className={input} value={f.name ?? ''} onChange={set('name')} placeholder="Ej: Barbería El Corte" /></div>
        <div><label className="text-xs font-medium text-stone-600">Slogan / Lema</label><input className={input} value={f.slogan ?? ''} onChange={set('slogan')} placeholder="Ej: El mejor corte de la ciudad ✂️" /></div>
        <div><label className="text-xs font-medium text-stone-600">Descripción corta</label><textarea className={input} rows={3} value={f.description ?? ''} onChange={set('description')} placeholder="Una o dos líneas sobre tu negocio." /></div>
      </div>
      <div className="flex justify-end mt-4">
        <button onClick={() => mSave.mutate()} disabled={!draft || mSave.isPending}
          className="rounded-lg bg-stone-900 hover:bg-stone-800 disabled:opacity-50 text-white font-semibold px-5 py-2 text-sm">
          {mSave.isPending ? 'Guardando…' : 'Guardar cambios'}
        </button>
      </div>
      {msg && <p className="text-sm text-stone-600 mt-2">{msg}</p>}
      <p className="text-[11px] text-stone-400 mt-3">Para cambiar tu correo o contraseña de acceso, contacta al administrador.</p>
    </div>
  )
}

// ── Bot: prompt (personalidad) + políticas ──
export function BotForm() {
  const { data, isLoading } = useQuery({ queryKey: ['policies'], queryFn: () => api<Policies>('/api/client/policies') })
  const [draft, setDraft] = useState<Policies | null>(null)
  const [msg, setMsg] = useState('')
  const f = draft ?? data

  const mSave = useMutation({
    mutationFn: () => api('/api/client/policies', { method: 'PUT', body: JSON.stringify(f) }),
    onSuccess: () => setMsg('✅ Guardado — el bot ya responde con esto'),
    onError: (e) => setMsg(`❌ ${e instanceof Error ? e.message : 'Error'}`),
  })

  if (isLoading || !f) return <p className="text-stone-500">Cargando…</p>
  const set = (k: keyof Policies) => (e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft({ ...f, [k]: e.target.value })

  return (
    <div className="bg-white rounded-xl border border-stone-200 p-5 max-w-2xl space-y-4">
      <div>
        <label className="text-xs font-medium text-stone-600">🤖 Prompt del bot (su personalidad y forma de atender)</label>
        <textarea className={`${input} font-mono text-xs`} rows={14} value={f.bot_prompt ?? ''} onChange={set('bot_prompt')}
          placeholder="Eres el asistente virtual de…" />
        <p className="text-[11px] text-stone-400 mt-1">⚠️ El prompt es la personalidad; los precios, totales y descuentos SIEMPRE los calcula el sistema (regla de dinero).</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="text-xs font-medium text-stone-600">🚚 Envíos</label><textarea className={input} rows={2} value={f.shipping ?? ''} onChange={set('shipping')} /></div>
        <div><label className="text-xs font-medium text-stone-600">↩️ Devoluciones</label><textarea className={input} rows={2} value={f.returns ?? ''} onChange={set('returns')} /></div>
        <div><label className="text-xs font-medium text-stone-600">🏷️ Descuentos (informativo)</label><textarea className={input} rows={2} value={f.discounts ?? ''} onChange={set('discounts')} /></div>
        <div><label className="text-xs font-medium text-stone-600">📌 Instrucciones extra</label><textarea className={input} rows={2} value={f.bot_instructions ?? ''} onChange={set('bot_instructions')} /></div>
      </div>
      <div className="flex justify-end">
        <button onClick={() => mSave.mutate()} disabled={!draft || mSave.isPending}
          className="rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold px-5 py-2 text-sm">
          {mSave.isPending ? 'Guardando…' : 'Guardar bot'}
        </button>
      </div>
      {msg && <p className="text-sm text-stone-600">{msg}</p>}
    </div>
  )
}

// ── Usuarios y permisos (clon de pg-usuarios del viejo): lista con el
// dueño arriba, tarjetas de empleados con Editar/Eliminar y modal.
const PERM_LABELS: Record<string, string> = {
  catalogo: '📦 Catálogo (agregar y editar productos)',
  conversaciones: '💬 Conversaciones (chatear con clientes)',
  citas: '📅 Citas y horarios',
  reportes: '📊 Reportes de ventas',
  ventas: '💰 Registrar ventas',
}

export function Team() {
  const qc = useQueryClient()
  const { data: users = [], isLoading } = useQuery({ queryKey: ['team'], queryFn: () => api<TeamUser[]>('/api/client/users') })
  const [modal, setModal] = useState<TeamUser | 'new' | null>(null)

  const refresh = () => qc.invalidateQueries({ queryKey: ['team'] })
  const mDelete = useMutation({ mutationFn: (id: string) => api(`/api/client/users/${id}`, { method: 'DELETE' }), onSettled: refresh })

  if (isLoading) return <p className="text-stone-500">Cargando equipo…</p>
  const dueño = users.filter(u => u.role === 'owner').map(u => u.email).join(', ') || '—'
  const emps = users.filter(u => u.role !== 'owner')

  return (
    <div className="max-w-2xl">
      <div className="flex justify-end mb-3">
        <button onClick={() => setModal('new')}
          className="rounded-lg bg-stone-900 hover:bg-stone-800 text-white text-sm font-semibold px-4 py-2">+ Nuevo empleado</button>
      </div>
      <p className="text-sm text-stone-500 mb-3">👑 Dueño: <strong className="text-stone-800">{dueño}</strong> (acceso total)</p>
      {emps.length === 0 && <p className="text-sm text-stone-500">Aún no tienes empleados. Crea el primero con el botón de arriba.</p>}
      {emps.map(u => (
        <div key={u.id} className="flex items-center justify-between bg-white border border-stone-200 rounded-xl px-4 py-3 mb-2">
          <div>
            <strong className="text-sm text-stone-900">{u.name || u.email}</strong>
            <div className="text-xs text-stone-500">{u.email} · {(u.permissions ?? []).length} permiso(s)</div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setModal(u)} className="text-xs rounded-lg border border-stone-200 px-2.5 py-1.5 hover:bg-stone-50">Editar</button>
            <button onClick={() => { if (confirm(`¿Eliminar a ${u.email}?`)) mDelete.mutate(u.id) }}
              className="text-xs rounded-lg border border-red-200 text-red-600 px-2.5 py-1.5 hover:bg-red-50">Eliminar</button>
          </div>
        </div>
      ))}
      {modal && <UserModal user={modal === 'new' ? null : modal} onClose={() => setModal(null)} onSaved={() => { setModal(null); refresh() }} />}
    </div>
  )
}

function UserModal({ user, onClose, onSaved }: { user: TeamUser | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: user?.name ?? '', email: user?.email ?? '', password: '',
    permissions: user?.permissions ?? [] as string[],
  })
  const [msg, setMsg] = useState('')
  const [saving, setSaving] = useState(false)
  const toggle = (p: string) => setF(v => ({ ...v, permissions: v.permissions.includes(p) ? v.permissions.filter(x => x !== p) : [...v.permissions, p] }))

  async function save() {
    if (!user && (!f.email || !f.password)) { setMsg('Correo y contraseña son obligatorios'); return }
    setSaving(true)
    try {
      if (user) {
        const body: Record<string, unknown> = { name: f.name, permissions: f.permissions }
        if (f.password) body.password = f.password
        await api(`/api/client/users/${user.id}`, { method: 'PUT', body: JSON.stringify(body) })
      } else {
        await api('/api/client/users', { method: 'POST', body: JSON.stringify(f) })
      }
      onSaved()
    } catch (e) { setMsg(`❌ ${e instanceof Error ? e.message : 'Error'}`); setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-30 bg-black/50 flex items-start justify-center overflow-y-auto p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded-2xl p-5 my-12" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-stone-900 mb-3">{user ? 'Editar empleado' : 'Nuevo empleado'}</h2>
        <div className="space-y-3">
          <div><label className="text-xs font-medium text-stone-600">Nombre</label><input className={input} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></div>
          <div><label className="text-xs font-medium text-stone-600">Correo {user ? '' : '*'}</label><input className={input} type="email" value={f.email} disabled={!!user} onChange={e => setF({ ...f, email: e.target.value })} /></div>
          <div><label className="text-xs font-medium text-stone-600">Contraseña {user ? '(solo si cambia)' : '*'}</label><input className={input} type="password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} /></div>
          <div>
            <label className="text-xs font-medium text-stone-600">Permisos (qué secciones puede ver)</label>
            <div className="space-y-1.5 mt-1">
              {Object.entries(PERM_LABELS).map(([p, label]) => (
                <label key={p} className="flex items-center gap-2 text-sm text-stone-700 cursor-pointer">
                  <input type="checkbox" checked={f.permissions.includes(p)} onChange={() => toggle(p)} />
                  {label}
                </label>
              ))}
            </div>
          </div>
        </div>
        {msg && <p className="text-sm text-red-600 mt-2">{msg}</p>}
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="rounded-lg border border-stone-200 text-stone-600 px-4 py-2 text-sm hover:bg-stone-50">Cancelar</button>
          <button onClick={save} disabled={saving}
            className="rounded-lg bg-stone-900 hover:bg-stone-800 disabled:opacity-50 text-white font-semibold px-5 py-2 text-sm">
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  )
}

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

const PERMS = [
  ['catalogo', '📦 Catálogo'], ['conversaciones', '💬 Conversaciones'],
  ['ventas', '🛒 Ventas'], ['reportes', '📊 Reportes'], ['citas', '📅 Citas'],
] as const

const input = 'w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500'

export default function Settings() {
  const isOwner = session.user?.role === 'owner'
  if (!isOwner) return <Locked />
  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-stone-900">Ajustes</h1>
        <p className="text-sm text-stone-500">Identidad de tu negocio (lo que el bot usa para presentarse)</p>
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

// ── Identidad del negocio (lo que el bot usa para presentarse) ──
export function BusinessForm() {
  const { data, isLoading } = useQuery({ queryKey: ['business'], queryFn: () => api<BusinessData>('/api/client/business') })
  const [draft, setDraft] = useState<BusinessData | null>(null)
  const [msg, setMsg] = useState('')
  const f = draft ?? data

  const mSave = useMutation({
    mutationFn: () => api('/api/client/business', { method: 'PUT', body: JSON.stringify(f) }),
    onSuccess: () => setMsg('✅ Guardado — el bot ya usa estos datos'),
    onError: (e) => setMsg(`❌ ${e instanceof Error ? e.message : 'Error'}`),
  })

  if (isLoading || !f) return <p className="text-stone-500">Cargando…</p>
  const set = (k: keyof BusinessData) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setDraft({ ...f, [k]: e.target.value })

  return (
    <div className="bg-white rounded-xl border border-stone-200 p-5 max-w-2xl">
      <div className="grid grid-cols-2 gap-3">
        <div><label className="text-xs font-medium text-stone-600">Nombre</label><input className={input} value={f.name ?? ''} onChange={set('name')} /></div>
        <div><label className="text-xs font-medium text-stone-600">Slogan</label><input className={input} value={f.slogan ?? ''} onChange={set('slogan')} /></div>
        <div className="col-span-2"><label className="text-xs font-medium text-stone-600">Descripción</label><textarea className={input} rows={2} value={f.description ?? ''} onChange={set('description')} /></div>
        <div><label className="text-xs font-medium text-stone-600">Dirección</label><input className={input} value={f.address ?? ''} onChange={set('address')} /></div>
        <div><label className="text-xs font-medium text-stone-600">Teléfono</label><input className={input} value={f.phone ?? ''} onChange={set('phone')} /></div>
        <div><label className="text-xs font-medium text-stone-600">Redes sociales</label><input className={input} value={f.social ?? ''} onChange={set('social')} /></div>
        <div><label className="text-xs font-medium text-stone-600">Métodos de pago</label><input className={input} value={f.payment_methods ?? ''} onChange={set('payment_methods')} /></div>
      </div>
      <div className="flex justify-end mt-4">
        <button onClick={() => mSave.mutate()} disabled={!draft || mSave.isPending}
          className="rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold px-5 py-2 text-sm">
          {mSave.isPending ? 'Guardando…' : 'Guardar cambios'}
        </button>
      </div>
      {msg && <p className="text-sm text-stone-600 mt-2">{msg}</p>}
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

// ── Equipo: empleados con permisos por sección ──
export function Team() {
  const qc = useQueryClient()
  const { data: users = [], isLoading } = useQuery({ queryKey: ['team'], queryFn: () => api<TeamUser[]>('/api/client/users') })
  const [form, setForm] = useState({ email: '', password: '', name: '', permissions: [] as string[] })
  const [msg, setMsg] = useState('')

  const refresh = () => qc.invalidateQueries({ queryKey: ['team'] })

  const mCreate = useMutation({
    mutationFn: () => api('/api/client/users', { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: () => { setForm({ email: '', password: '', name: '', permissions: [] }); setMsg('✅ Empleado creado'); refresh() },
    onError: (e) => setMsg(`❌ ${e instanceof Error ? e.message : 'Error'}`),
  })
  const mDelete = useMutation({ mutationFn: (id: string) => api(`/api/client/users/${id}`, { method: 'DELETE' }), onSettled: refresh })
  const mPerms = useMutation({
    mutationFn: (v: { id: string; permissions: string[] }) => api(`/api/client/users/${v.id}`, { method: 'PUT', body: JSON.stringify({ permissions: v.permissions }) }),
    onSettled: refresh,
  })

  const togglePerm = (list: string[], p: string) => list.includes(p) ? list.filter(x => x !== p) : [...list, p]

  if (isLoading) return <p className="text-stone-500">Cargando equipo…</p>

  return (
    <div className="grid lg:grid-cols-2 gap-4 max-w-4xl">
      <div className="bg-white rounded-xl border border-stone-200 p-5">
        <h2 className="font-semibold text-stone-900 mb-3">Tu equipo ({users.length})</h2>
        {users.length === 0 && <p className="text-sm text-stone-500">Solo tú por ahora. Crea cuentas para tus empleados con permisos limitados.</p>}
        <div className="space-y-3">
          {users.map(u => (
            <div key={u.id} className="border border-stone-100 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-sm text-stone-900">{u.name || u.email} {u.role === 'owner' && <span className="text-[10px] bg-green-50 text-green-700 rounded px-1.5 py-0.5 ml-1">DUEÑO</span>}</div>
                  <div className="text-xs text-stone-400">{u.email}</div>
                </div>
                {u.role !== 'owner' && (
                  <button onClick={() => { if (confirm(`¿Eliminar a ${u.email}?`)) mDelete.mutate(u.id) }}
                    className="text-xs text-red-600 border border-red-200 rounded px-2 py-1 hover:bg-red-50">Eliminar</button>
                )}
              </div>
              {u.role !== 'owner' && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {PERMS.map(([p, label]) => (
                    <label key={p} className="flex items-center gap-1 text-xs text-stone-600 cursor-pointer">
                      <input type="checkbox" checked={(u.permissions ?? []).includes(p)}
                        onChange={() => mPerms.mutate({ id: u.id, permissions: togglePerm(u.permissions ?? [], p) })} />
                      {label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-stone-200 p-5">
        <h2 className="font-semibold text-stone-900 mb-3">+ Nuevo empleado</h2>
        <div className="space-y-3">
          <div><label className="text-xs font-medium text-stone-600">Nombre</label><input className={input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
          <div><label className="text-xs font-medium text-stone-600">Correo *</label><input className={input} type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></div>
          <div><label className="text-xs font-medium text-stone-600">Contraseña *</label><input className={input} type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></div>
          <div>
            <label className="text-xs font-medium text-stone-600">Permisos (qué secciones puede ver)</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {PERMS.map(([p, label]) => (
                <label key={p} className="flex items-center gap-1 text-xs text-stone-600 cursor-pointer">
                  <input type="checkbox" checked={form.permissions.includes(p)}
                    onChange={() => setForm({ ...form, permissions: togglePerm(form.permissions, p) })} />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <button onClick={() => mCreate.mutate()} disabled={!form.email || !form.password || mCreate.isPending}
            className="w-full rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold py-2 text-sm">
            {mCreate.isPending ? 'Creando…' : 'Crear empleado'}
          </button>
          {msg && <p className="text-sm text-stone-600">{msg}</p>}
        </div>
      </div>
    </div>
  )
}

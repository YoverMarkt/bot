import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { session, type Business, type PanelUser } from '../../api/client'

type LoginResponse = { token: string; business: Business; user?: PanelUser; error?: string }

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/client/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const d = (await res.json()) as LoginResponse
      if (!res.ok) throw new Error(d.error || 'No se pudo iniciar sesión')
      session.save(d.token, d.business, d.user ?? { name: '', role: 'owner', permissions: [] })
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de conexión')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-stone-100 px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-stone-200 p-8">
        <div className="mb-6 text-center">
          <div className="text-3xl mb-2">🤖</div>
          <h1 className="text-xl font-bold text-stone-900">Panel de tu negocio</h1>
          <p className="text-sm text-stone-500 mt-1">Inicia sesión para continuar</p>
        </div>

        <label className="block text-sm font-medium text-stone-700 mb-1">Correo</label>
        <input
          type="email" required value={email} onChange={e => setEmail(e.target.value)}
          className="w-full rounded-lg border border-stone-300 px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-green-500"
          placeholder="tu@negocio.com" autoComplete="email"
        />

        <label className="block text-sm font-medium text-stone-700 mb-1">Contraseña</label>
        <input
          type="password" required value={password} onChange={e => setPassword(e.target.value)}
          className="w-full rounded-lg border border-stone-300 px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-green-500"
          placeholder="••••••••" autoComplete="current-password"
        />

        {error && <p className="text-sm text-red-600 mb-3">❌ {error}</p>}

        <button
          type="submit" disabled={loading}
          className="w-full rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-60 text-white font-semibold py-2.5 transition-colors"
        >
          {loading ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  )
}

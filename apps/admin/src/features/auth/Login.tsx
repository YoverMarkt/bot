import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { session } from '../../api/client'

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
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const d = (await res.json()) as { token?: string; error?: string }
      if (!res.ok || !d.token) throw new Error(d.error || 'Credenciales incorrectas')
      session.save(d.token)
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de conexión')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-stone-950 px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm bg-stone-900 rounded-2xl border border-stone-800 p-8">
        <div className="mb-6 text-center">
          <div className="text-3xl mb-2">👑</div>
          <h1 className="text-xl font-bold text-white">BotPanel — Admin</h1>
          <p className="text-sm text-stone-400 mt-1">Panel del dueño del SaaS</p>
        </div>

        <label className="block text-sm font-medium text-stone-300 mb-1">Correo</label>
        <input
          type="email" required value={email} onChange={e => setEmail(e.target.value)}
          className="w-full rounded-lg bg-stone-800 border border-stone-700 text-white px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-green-500"
          autoComplete="email"
        />

        <label className="block text-sm font-medium text-stone-300 mb-1">Contraseña</label>
        <input
          type="password" required value={password} onChange={e => setPassword(e.target.value)}
          className="w-full rounded-lg bg-stone-800 border border-stone-700 text-white px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-green-500"
          autoComplete="current-password"
        />

        {error && <p className="text-sm text-red-400 mb-3">❌ {error}</p>}

        <button type="submit" disabled={loading}
          className="w-full rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-60 text-white font-semibold py-2.5 transition-colors">
          {loading ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  )
}

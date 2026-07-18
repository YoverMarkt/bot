import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { session, type Business, type PanelUser } from '../../api/client'
import { queryClient } from '../../lib/queryClient'
import { Button } from '@botpanel/ui/components/button'
import { Input } from '@botpanel/ui/components/input'
import { Label } from '@botpanel/ui/components/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@botpanel/ui/components/card'
import { Bot } from 'lucide-react'

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
      // Sin esto, el negocio nuevo hereda el caché (módulos y datos) del anterior
      queryClient.clear()
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de conexión')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <Bot className="w-8 h-8 mx-auto mb-1 text-primary" />
          <CardTitle className="text-xl"><h1>Panel de tu negocio</h1></CardTitle>
          <CardDescription>Inicia sesión para continuar</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Correo</Label>
              <Input id="email" type="email" required value={email} onChange={e => setEmail(e.target.value)}
                placeholder="tu@negocio.com" autoComplete="email" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Contraseña</Label>
              <Input id="password" type="password" required value={password} onChange={e => setPassword(e.target.value)}
                placeholder="••••••••" autoComplete="current-password" />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">✗ {error}</p>}
            <Button variant="ghost" type="submit" disabled={loading} className="w-full">
              {loading ? 'Entrando…' : 'Entrar'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

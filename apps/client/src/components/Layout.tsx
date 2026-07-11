import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, session } from '../api/client'
import { useBusinessInfo, isBookingBiz, isServiceBiz } from '../lib/biz'
import { Home, Package, MessageSquare, BarChart3, Users, RotateCcw, Bot, Clock, Calendar, UserRound, Settings, Archive, LogOut, Sun, Moon } from 'lucide-react'
import { useState } from 'react'
import { getTheme, toggleTheme } from '../lib/theme'
import { useAttention, AlarmBanner } from './AlarmSystem'
import { Button } from '@/components/ui/button'

// Secciones del panel (mismas reglas del panel viejo):
// · `perm` controla visibilidad para empleados (el dueño ve todo; el SERVIDOR valida siempre)
// · Reservas SOLO para negocios de citas (barbería, clínica…) — Mas Pura no la ve
// · Horarios para TODOS (horario de atención; el bot avisa fuera de horario)
// · Catálogo se llama "Servicios" en negocios de servicios

export default function Layout() {
  const navigate = useNavigate()
  const [theme, setTheme] = useState(getTheme())
  const user = session.user
  const biz = session.business
  const { data: bizInfo } = useBusinessInfo()

  const bookingBiz = isBookingBiz(bizInfo?.type)
  const canSee = (perm: string | null) => {
    if (!perm) return true
    if (user?.role === 'owner') return true
    if (perm === 'owner') return false
    return (user?.permissions ?? []).includes(perm)
  }

  // Contador de productos junto a "Catálogo" (sb-cnt del panel viejo)
  const { data: quick } = useQuery({
    queryKey: ['quick-stats'],
    queryFn: () => api<{ totalProducts: number }>('/api/client/stats'),
    staleTime: 60_000,
  })

  const att = useAttention({
    watchSessions: canSee('conversaciones'),
    watchBookings: bookingBiz && canSee('citas'),
  })

  // Menú IDÉNTICO al panel viejo (mismo orden, mismas secciones)
  const SECTIONS: { to: string; label: string; icon: React.ComponentType<{ className?: string }>; perm: string | null; badge?: string | number; badgeTone?: 'alert' | 'count' }[] = [
    { to: '/',              label: 'Inicio',            icon: Home, perm: null },
    { to: '/catalog',       label: isServiceBiz(bizInfo?.type) ? 'Servicios' : 'Catálogo', icon: Package, perm: 'catalogo', badge: quick?.totalProducts || undefined, badgeTone: 'count' as const },
    { to: '/conversations', label: 'Conversaciones',    icon: MessageSquare, perm: 'conversaciones', badge: att.manual.length ? '!' : undefined },
    { to: '/reports',       label: 'Reportes',          icon: BarChart3, perm: 'reportes' },
    { to: '/customers',     label: 'Clientes',          icon: Users, perm: 'reportes' },
    { to: '/reactivate',    label: 'Reactivar',         icon: RotateCcw, perm: 'reportes' },
    { to: '/bot-prompt',    label: 'Prompt del Bot',    icon: Bot, perm: 'owner' },
    { to: '/schedule',      label: 'Horarios',          icon: Clock, perm: 'citas' },
    ...(bookingBiz ? [{ to: '/bookings', label: 'Reservas', icon: Calendar, perm: 'citas', badge: att.pending.length || undefined }] : []),
    { to: '/users',         label: 'Usuarios',          icon: UserRound, perm: 'owner' },
    { to: '/settings',      label: 'Ajustes',           icon: Settings, perm: 'owner' },
  ]

  function logout() {
    session.clear()
    navigate('/login')
  }

  return (
    <div className="min-h-screen flex bg-muted">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 bg-card border-r flex flex-col">
        <div className="px-5 py-4 border-b border-border/60">
          <div className="font-bold text-foreground truncate">{biz?.name ?? 'Mi negocio'}</div>
          <div className="text-xs text-muted-foreground">{biz?.type ?? ''}</div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {SECTIONS.filter(s => canSee(s.perm)).map(s => (
            <NavLink
              key={s.to} to={s.to} end={s.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/50'
                }`
              }
            >
              <s.icon className="w-4 h-4" />
              <span className="flex-1">{s.label}</span>
              {s.badge !== undefined && (
                <span className={`text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-5 text-center ${
                  s.badgeTone === 'count' ? 'bg-muted text-muted-foreground' : 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'
                }`}>
                  {s.badge}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-border/60">
          <a href="/client-legacy" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground/80 hover:bg-muted/50">
            <Archive className="w-4 h-4" /> Panel clásico
          </a>
          <Button variant="ghost" onClick={() => setTheme(toggleTheme())} className="w-full justify-start">
            <span className="inline-flex items-center gap-2">
              {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              {theme === 'dark' ? 'Tema claro' : 'Tema oscuro'}
            </span>
          </Button>
          <div className="px-3 pb-2 text-xs text-muted-foreground truncate">{user?.name || 'Sesión activa'}</div>
          <Button variant="ghost" onClick={logout} className="w-full justify-start">
            <span className="inline-flex items-center gap-2"><LogOut className="w-4 h-4" /> Cerrar sesión</span>
          </Button>
        </div>
      </aside>

      {/* Contenido */}
      <main className="flex-1 min-w-0 p-6">
        <Outlet />
      </main>

      {/* Alarma global (chats manuales sin atender + reservas pendientes) */}
      <AlarmBanner manual={att.manual} pending={att.pending} bookings={att.bookings} />
    </div>
  )
}

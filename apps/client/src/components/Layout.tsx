import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, session } from '../api/client'
import { useBusinessInfo, isBookingBiz, isServiceBiz } from '../lib/biz'
import { useAttention, AlarmBanner } from './AlarmSystem'

// Secciones del panel (mismas reglas del panel viejo):
// · `perm` controla visibilidad para empleados (el dueño ve todo; el SERVIDOR valida siempre)
// · Reservas SOLO para negocios de citas (barbería, clínica…) — Mas Pura no la ve
// · Horarios para TODOS (horario de atención; el bot avisa fuera de horario)
// · Catálogo se llama "Servicios" en negocios de servicios

export default function Layout() {
  const navigate = useNavigate()
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
  const SECTIONS: { to: string; label: string; icon: string; perm: string | null; badge?: string | number; badgeTone?: 'alert' | 'count' }[] = [
    { to: '/',              label: 'Inicio',            icon: '🏠', perm: null },
    { to: '/catalog',       label: isServiceBiz(bizInfo?.type) ? 'Servicios' : 'Catálogo', icon: '📦', perm: 'catalogo', badge: quick?.totalProducts || undefined, badgeTone: 'count' as const },
    { to: '/conversations', label: 'Conversaciones',    icon: '💬', perm: 'conversaciones', badge: att.manual.length ? '!' : undefined },
    { to: '/reports',       label: 'Reportes',          icon: '📊', perm: 'reportes' },
    { to: '/customers',     label: 'Clientes',          icon: '👥', perm: 'reportes' },
    { to: '/reactivate',    label: 'Reactivar',         icon: '🔄', perm: 'reportes' },
    { to: '/bot-prompt',    label: 'Prompt del Bot',    icon: '🤖', perm: 'owner' },
    { to: '/schedule',      label: 'Horarios',          icon: '🕐', perm: 'citas' },
    ...(bookingBiz ? [{ to: '/bookings', label: 'Reservas', icon: '📅', perm: 'citas', badge: att.pending.length || undefined }] : []),
    { to: '/users',         label: 'Usuarios',          icon: '👤', perm: 'owner' },
    { to: '/settings',      label: 'Ajustes',           icon: '⚙️', perm: 'owner' },
  ]

  function logout() {
    session.clear()
    navigate('/login')
  }

  return (
    <div className="min-h-screen flex bg-stone-100">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 bg-white border-r border-stone-200 flex flex-col">
        <div className="px-5 py-4 border-b border-stone-100">
          <div className="font-bold text-stone-900 truncate">{biz?.name ?? 'Mi negocio'}</div>
          <div className="text-xs text-stone-500">{biz?.type ?? ''}</div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {SECTIONS.filter(s => canSee(s.perm)).map(s => (
            <NavLink
              key={s.to} to={s.to} end={s.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive ? 'bg-green-50 text-green-800' : 'text-stone-600 hover:bg-stone-50'
                }`
              }
            >
              <span>{s.icon}</span>
              <span className="flex-1">{s.label}</span>
              {s.badge !== undefined && (
                <span className={`text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-5 text-center ${
                  s.badgeTone === 'count' ? 'bg-stone-100 text-stone-600' : 'bg-amber-100 text-amber-800'
                }`}>
                  {s.badge}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-stone-100">
          <a href="/client-legacy" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-stone-400 hover:bg-stone-50">
            🗂 Panel clásico
          </a>
          <div className="px-3 pb-2 text-xs text-stone-500 truncate">{user?.name || 'Sesión activa'}</div>
          <button onClick={logout} className="w-full text-left rounded-lg px-3 py-2 text-sm text-stone-600 hover:bg-stone-50">
            🚪 Cerrar sesión
          </button>
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

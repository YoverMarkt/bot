import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { session } from '../api/client'

// Secciones del panel. `perm` controla visibilidad para empleados
// (el dueño ve todo; el SERVIDOR valida siempre, esto es solo UI).
const SECTIONS = [
  { to: '/',              label: 'Inicio',         icon: '🏠', perm: 'reportes' },
  { to: '/conversations', label: 'Conversaciones', icon: '💬', perm: 'conversaciones' },
  { to: '/catalog',       label: 'Catálogo',       icon: '📦', perm: 'catalogo' },
  { to: '/sales',         label: 'Ventas',         icon: '🛒', perm: 'ventas' },
  { to: '/reports',       label: 'Reportes',       icon: '📊', perm: 'reportes' },
  { to: '/customers',     label: 'Clientes',       icon: '👥', perm: 'reportes' },
  { to: '/bookings',      label: 'Citas',          icon: '📅', perm: 'citas' },
  { to: '/settings',      label: 'Configuración',  icon: '⚙️', perm: null },
]

export default function Layout() {
  const navigate = useNavigate()
  const user = session.user
  const biz = session.business

  const canSee = (perm: string | null) =>
    !perm || user?.role === 'owner' || (user?.permissions ?? []).includes(perm)

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
              <span>{s.icon}</span> {s.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-stone-100">
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
    </div>
  )
}

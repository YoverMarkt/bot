import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { session } from '../api/client'

const SECTIONS = [
  { to: '/',            label: 'Dashboard',     icon: '🏠' },
  { to: '/clients',     label: 'Clientes',      icon: '👥' },
  { to: '/billing',     label: 'Facturación',   icon: '💳' },
  { to: '/simulator',   label: 'Simulador',     icon: '💬' },
  { to: '/connections', label: 'Conexiones',    icon: '🔌' },
  { to: '/settings',    label: 'Configuración', icon: '⚙️' },
  { to: '/calculator',  label: 'Calculadora',   icon: '🧮' },
]

export default function Layout() {
  const navigate = useNavigate()

  function logout() {
    session.clear()
    navigate('/login')
  }

  return (
    <div className="min-h-screen flex bg-stone-950">
      <aside className="w-60 shrink-0 bg-stone-900 border-r border-stone-800 flex flex-col">
        <div className="px-5 py-4 border-b border-stone-800">
          <div className="font-bold text-white">👑 BotPanel</div>
          <div className="text-xs text-stone-500">Superadmin</div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {SECTIONS.map(s => (
            <NavLink key={s.to} to={s.to} end={s.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive ? 'bg-green-600/15 text-green-400' : 'text-stone-400 hover:bg-stone-800'
                }`
              }>
              <span>{s.icon}</span> {s.label}
            </NavLink>
          ))}
          <div className="pt-3 mt-3 border-t border-stone-800">
            <a href="/admin-legacy"
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-stone-500 hover:bg-stone-800">
              🗂 Panel clásico
            </a>
          </div>
        </nav>
        <div className="p-3 border-t border-stone-800">
          <button onClick={logout} className="w-full text-left rounded-lg px-3 py-2 text-sm text-stone-400 hover:bg-stone-800">
            🚪 Cerrar sesión
          </button>
        </div>
      </aside>
      <main className="flex-1 min-w-0 p-6">
        <Outlet />
      </main>
    </div>
  )
}

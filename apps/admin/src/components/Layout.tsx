import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { session } from '../api/client'

const SECTIONS = [
  { to: '/',        label: 'Inicio',   icon: '🏠' },
  { to: '/clients', label: 'Negocios', icon: '🏪' },
]

// Secciones aún en el panel viejo (se migran por fases — estrangulador)
const LEGACY = [
  { href: '/admin', label: 'Facturación' },
  { href: '/admin', label: 'Configuración' },
  { href: '/admin', label: 'Simulador' },
  { href: '/admin', label: 'Calculadora' },
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
            <div className="px-3 pb-1 text-[10px] uppercase tracking-wide text-stone-600">En el panel actual</div>
            {LEGACY.map(l => (
              <a key={l.label} href={l.href}
                className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-stone-500 hover:bg-stone-800">
                🚧 {l.label}
              </a>
            ))}
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

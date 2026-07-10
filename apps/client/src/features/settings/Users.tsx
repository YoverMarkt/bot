import { session } from '../../api/client'
import { Team, Locked } from './Settings'

// ── Usuarios y permisos (sección propia, igual que el panel viejo) ──
export default function Users() {
  const isOwner = session.user?.role === 'owner'
  if (!isOwner) return <Locked />
  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-stone-900">Usuarios y permisos</h1>
        <p className="text-sm text-stone-500">Crea empleados con acceso limitado a tu panel</p>
      </div>
      <Team />
    </div>
  )
}

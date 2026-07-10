import { useQuery } from '@tanstack/react-query'
import { getStats, getClients } from '../clients/api'

export default function Dashboard() {
  const { data, isLoading, error } = useQuery({ queryKey: ['adm-stats'], queryFn: getStats, refetchInterval: 30_000 })
  const { data: clients = [] } = useQuery({ queryKey: ['adm-clients'], queryFn: getClients })

  if (isLoading) return <p className="text-stone-400">Cargando…</p>
  if (error) return <p className="text-red-400">❌ {(error as Error).message}</p>
  if (!data) return null

  const cards = [
    { label: 'Negocios totales', value: data.totalClients, icon: '🏪' },
    { label: 'Bots activos', value: data.activeClients, icon: '🤖' },
    { label: 'Suspendidos', value: data.suspendedClients, icon: '⛔' },
    { label: 'Mensajes (últimas 24h)', value: data.messagesToday, icon: '💬' },
  ]

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-1">Inicio</h1>
      <p className="text-sm text-stone-400 mb-6">El pulso de tu SaaS</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map(c => (
          <div key={c.label} className="bg-stone-900 rounded-xl border border-stone-800 p-5">
            <div className="text-2xl mb-1">{c.icon}</div>
            <div className="text-3xl font-bold text-white">{c.value}</div>
            <div className="text-xs uppercase tracking-wide text-stone-500 mt-1">{c.label}</div>
          </div>
        ))}
      </div>

      {/* Últimos negocios (renderDashRecent del panel viejo) */}
      <div className="bg-stone-900 rounded-xl border border-stone-800 p-5 mt-6 max-w-2xl">
        <h2 className="text-sm font-semibold text-white mb-2">🏪 Negocios recientes</h2>
        {clients.length === 0 && <p className="text-sm text-stone-500">Sin clientes aún.</p>}
        {clients.slice(0, 6).map(c => (
          <div key={c.id} className="flex items-center gap-3 py-2.5 border-b border-stone-800/60 last:border-0">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-white truncate">{c.name}</div>
              <div className="text-xs text-stone-500">{c.type || ''} · {c.whatsapp_number || 'sin número'}</div>
            </div>
            {c.suspended
              ? <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-red-500/10 text-red-400">⛔ Suspendido</span>
              : !c.bot_active
                ? <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-amber-500/10 text-amber-400">⏸️ Pausado</span>
                : <span className="text-[11px] font-semibold rounded px-2 py-0.5 bg-green-500/10 text-green-400">✅ Activo</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

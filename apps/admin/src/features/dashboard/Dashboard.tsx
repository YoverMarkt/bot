import { useQuery } from '@tanstack/react-query'
import { getStats } from '../clients/api'

export default function Dashboard() {
  const { data, isLoading, error } = useQuery({ queryKey: ['adm-stats'], queryFn: getStats, refetchInterval: 30_000 })

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
    </div>
  )
}

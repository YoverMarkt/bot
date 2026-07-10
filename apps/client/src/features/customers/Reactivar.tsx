import { Reactivate } from './Customers'

// ── Reactivar (sección propia, igual que el panel viejo) ──
export default function Reactivar() {
  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-stone-900">Clientes sin escribir</h1>
        <p className="text-sm text-stone-500">Consultaron y hace tiempo no vuelven. Ideal para reactivar.</p>
      </div>
      <Reactivate />
    </div>
  )
}

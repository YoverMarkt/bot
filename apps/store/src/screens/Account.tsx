import { useEffect, useState } from 'react'
import { ChevronLeft, MapPin, Trash2 } from 'lucide-react'
import { Aviso } from '../components/ui'
import { getOrders } from '../lib/api'
import { money } from '../lib/format'
import type { Address, Me, TrackedOrder } from '../lib/types'

// ── LA CUENTA DEL CLIENTE ──────────────────────────────────────────────────
//
// Sus pedidos y sus direcciones, en un solo sitio.
//
// La pestaña de abajo decía «Pedido» y abría el ÚLTIMO pedido directamente.
// Servía mientras solo hubiera uno del que preocuparse, pero un cliente que ha
// pedido cinco veces no tiene «un pedido»: tiene un historial. Y desde que la
// pantalla de pago dejó de ofrecer el atajo al seguimiento, hacía falta una
// puerta estable para mirar cómo va lo de uno.
//
// Es la casa de lo que venga después: datos personales, favoritos, o lo que el
// dueño decida. Hoy son dos secciones y ya justifica la pestaña.
//
// ⚠️ La lista de pedidos es de SOLO LECTURA desde el 2026-08-12. Tocar uno
// abría su seguimiento, y esa pantalla se retiró: el pedido se sigue por
// WhatsApp. Lo que se conserva —y no es poco— es el estado dicho en cristiano
// junto a cada pedido: si el aviso no llegara (sin saldo en el canal, o fuera
// de la ventana de 24 h), este es el único sitio de la app donde el cliente
// puede comprobar por dónde va lo suyo. Una fila que no lleva a ninguna parte
// no debe FINGIR que sí, así que deja de ser un botón.

/** Los doce estados internos, dichos como los entiende quien compró. */
const COMO_VA: Record<string, { texto: string; tono: string }> = {
  esperando_pago: { texto: 'Falta tu pago', tono: 'text-amber-600 dark:text-amber-400' },
  pago_en_revision: { texto: 'Revisando tu pago', tono: 'texto-tenue' },
  pendiente: { texto: 'Recibido', tono: 'texto-tenue' },
  confirmado: { texto: 'En preparación', tono: 'text-marca' },
  aceptado: { texto: 'En preparación', tono: 'text-marca' },
  preparacion: { texto: 'En preparación', tono: 'text-marca' },
  listo_para_retiro: { texto: 'Listo para retirar', tono: 'text-marca' },
  en_camino: { texto: 'En camino', tono: 'text-marca' },
  completado: { texto: 'Entregado', tono: 'texto-tenue' },
  cancelado: { texto: 'Cancelado', tono: 'texto-tenue' },
  rechazado: { texto: 'Rechazado', tono: 'texto-tenue' },
  expirado: { texto: 'Expirado', tono: 'texto-tenue' },
}

const cuando = (iso: string) => {
  const fecha = new Date(iso)
  if (Number.isNaN(fecha.getTime())) return ''
  return fecha.toLocaleDateString('es-EC', {
    timeZone: 'America/Guayaquil', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

export default function Account({
  slug, me, onVolver, onBorrarDireccion,
}: {
  slug: string
  me: Me | null
  onVolver: () => void
  onBorrarDireccion: (addressId: string) => Promise<void>
}) {
  const [pedidos, setPedidos] = useState<TrackedOrder[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getOrders(slug)
      .then(setPedidos)
      .catch(() => setError('No pudimos cargar tus pedidos'))
  }, [slug])

  const direcciones: Address[] = me?.addresses || []

  return (
    <div className="mx-auto min-h-[100dvh] max-w-md pb-24">
      <header className="superficie sticky top-0 z-30 flex items-center gap-2 border-b borde-tema px-4 py-4">
        <button onClick={onVolver} aria-label="Volver" className="-ml-2 p-2 transition active:scale-95">
          <ChevronLeft size={20} />
        </button>
        <h1 className="text-[19px] font-extrabold tracking-tight">Mi cuenta</h1>
      </header>

      <div className="space-y-7 px-4 pt-5">
        {me?.phone && (
          <p className="text-[13px] texto-tenue">
            Tus pedidos y direcciones en este local, ligados a tu WhatsApp {me.phone}.
          </p>
        )}

        {/* ── Mis pedidos ── */}
        <section>
          <h2 className="mb-2.5 text-[17px] font-extrabold tracking-tight">
            Mis pedidos
          </h2>

          {error && <Aviso tono="alerta">{error}</Aviso>}

          {/* Esqueleto con la forma de la lista, no una rueda girando: así la
              pantalla no salta cuando llegan los datos. */}
          {!pedidos && !error && (
            <div className="space-y-2">
              {[0, 1].map(fila => (
                <div key={fila} className="h-[68px] animate-pulse rounded-2xl border borde-tema" />
              ))}
            </div>
          )}

          {pedidos?.length === 0 && (
            <div className="rounded-2xl border border-dashed borde-tema px-4 py-8 text-center">
              <p className="text-[14px] font-semibold">Todavía no has pedido nada</p>
              <p className="mt-1 text-[13px] texto-tenue">
                Cuando hagas tu primer pedido, aparecerá aquí.
              </p>
            </div>
          )}

          <div className="space-y-2">
            {(pedidos || []).map((pedido) => {
              const estado = COMO_VA[pedido.status] || { texto: pedido.status, tono: 'texto-tenue' }
              const cuantos = (pedido.order_items || []).length
              return (
                <div
                  key={pedido.id}
                  className="superficie flex w-full items-center gap-3 rounded-2xl border borde-tema px-4 py-3.5 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="text-[14.5px] font-bold">#{pedido.order_number}</span>
                      <span className={`text-[13px] font-semibold ${estado.tono}`}>
                        {estado.texto}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[12.5px] texto-tenue">
                      {cuando(pedido.created_at)}
                      {cuantos > 0 && ` · ${cuantos} ${cuantos === 1 ? 'producto' : 'productos'}`}
                    </span>
                  </span>
                  <span className="shrink-0 text-[15.5px] font-bold tabular-nums">
                    {money(Number(pedido.total) || 0)}
                  </span>
                </div>
              )
            })}
          </div>
        </section>

        {/* ── Mis direcciones ── */}
        <section>
          <h2 className="mb-2.5 text-[17px] font-extrabold tracking-tight">
            Mis direcciones
          </h2>

          {direcciones.length === 0 && (
            <div className="rounded-2xl border border-dashed borde-tema px-4 py-6 text-center">
              <p className="text-[13px] texto-tenue">
                Las direcciones que guardes al pedir aparecerán aquí.
              </p>
            </div>
          )}

          <div className="space-y-2">
            {direcciones.map(direccion => (
              <div
                key={direccion.id}
                className="superficie flex items-start gap-2 rounded-2xl border borde-tema px-4 py-3.5"
              >
                <MapPin size={17} className="mt-0.5 shrink-0 texto-tenue" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold">{direccion.label}</span>
                  <span className="block text-[13px] texto-tenue">{direccion.address}</span>
                  {direccion.reference && (
                    <span className="block text-[12px] texto-tenue">{direccion.reference}</span>
                  )}
                </span>
                <button
                  onClick={() => {
                    if (!window.confirm(`¿Eliminar «${direccion.label}»?`)) return
                    void onBorrarDireccion(direccion.id)
                  }}
                  aria-label={`Eliminar ${direccion.label}`}
                  className="-mr-1 shrink-0 rounded-full p-1.5 texto-tenue transition active:scale-90"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

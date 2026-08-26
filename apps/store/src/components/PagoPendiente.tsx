import { useEffect, useState } from 'react'
import { Copy, Landmark } from 'lucide-react'
import { getPaymentInfo } from '../lib/api'
import type { BankAccount } from '../lib/types'

// ── A DÓNDE TRANSFERIR ─────────────────────────────────────────────────────
//
// Los datos bancarios del negocio, y nada más.
//
// ⚠️ Aquí había además un botón para SUBIR el comprobante, y se retiró el
// 2026-08-12. No porque fallara —funcionaba—, sino porque eran dos caminos
// para lo mismo y el de la app era el que casi nadie tomaba: la gente
// transfiere desde su banco y la captura le queda en la galería del teléfono,
// a un toque del chat donde le llegó el enlace de la tienda. Pedirle que
// vuelva a la tienda, encuentre el pedido y la suba otra vez es trabajo de más
// para llegar al mismo sitio.
//
// Lo que hace que quitarlo no pierda nada: la foto que llega por el chat YA se
// adjunta sola al pedido (`services/payment-proof-inbox.ts`) — misma RPC,
// mismo estado `pago_en_revision`, misma alarma en el panel y el mismo «Ver
// comprobante» con firma temporal. El dueño no nota diferencia.
//
// ⚠️ Se conserva el `<a>` de vuelta a WhatsApp en la pantalla que envuelve a
// esto (`screens/OrderPlaced.tsx`), no aquí: con el enlace en los dos sitios
// había dos botones verdes compitiendo en la misma pantalla por el mismo
// gesto. La instrucción y el botón van juntos, y este bloque solo informa.
//
// La ruta `POST /api/store/:slug/orders/:id/proof` sigue viva en el servidor,
// protegida y con sus pruebas. No se borró a propósito: funciona, no estorba,
// y es la puerta que usaría el Marketplace o una vuelta atrás. Lo que ya no
// existe es quien la llame desde esta app.

const lineasBanco = (cuenta: BankAccount) => [
  { etiqueta: 'Banco', valor: cuenta.bank_name },
  { etiqueta: 'Tipo', valor: cuenta.account_type },
  { etiqueta: 'Número', valor: cuenta.account_number, copiable: true },
  { etiqueta: 'Titular', valor: cuenta.holder_name },
  { etiqueta: 'Cédula / RUC', valor: cuenta.holder_id, copiable: true },
].filter(linea => Boolean(linea.valor))

export default function PagoPendiente({ slug }: { slug: string }) {
  const [cuenta, setCuenta] = useState<BankAccount | null>(null)
  const [copiado, setCopiado] = useState('')

  useEffect(() => {
    getPaymentInfo(slug).then(setCuenta).catch(() => setCuenta(null))
  }, [slug])

  const copiar = async (texto: string) => {
    try {
      await navigator.clipboard.writeText(texto)
      setCopiado(texto)
      setTimeout(() => setCopiado(''), 1800)
    } catch { /* sin portapapeles: el número está a la vista igual */ }
  }

  const filas = cuenta ? lineasBanco(cuenta) : []
  // Sin datos cargados no se pinta un título con un hueco debajo. El negocio
  // que no los tenga coordina el pago por el chat, que es la salida de todos
  // modos.
  if (filas.length === 0) return null

  return (
    <section className="w-full text-left">
      <h2 className="titulo-l mb-2.5 flex items-center gap-2 px-1">
        <Landmark size={18} className="texto-tenue" />
        Para transferir
      </h2>

      <div className="superficie divide-y divide-(--linea) overflow-hidden rounded-(--radius-tarjeta) shadow-tarjeta">
        {filas.map(({ etiqueta, valor, copiable }) => (
          <div key={etiqueta} className="flex items-center justify-between gap-3 px-4 py-3.5">
            <span className="caption texto-tenue">{etiqueta}</span>
            <span className="flex items-center gap-2 text-right text-[14.5px] font-semibold">
              {String(valor)}
              {copiable && (
                <button
                  onClick={() => copiar(String(valor))}
                  aria-label={`Copiar ${etiqueta}`}
                  className="-mr-1 flex size-8 shrink-0 items-center justify-center rounded-full transition active:scale-90"
                >
                  {/* ⚠️ El «copiado» va en `acento` SÓLIDO, no con el acento de
                      letra: un icono de 15 px en el lima de la plataforma da
                      1,19:1 sobre blanco y desaparece justo cuando su trabajo
                      es confirmar que el número de cuenta ya está copiado.
                      Antes se distinguían por un color que no se veía; ahora,
                      por la pastilla, que se ve sin mirar. */}
                  <span className={`flex size-7 items-center justify-center rounded-full transition ${
                    copiado === String(valor) ? 'acento shadow-acento' : 'texto-tenue'
                  }`}
                  >
                    <Copy size={15} />
                  </span>
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

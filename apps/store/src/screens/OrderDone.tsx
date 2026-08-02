import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Copy, Landmark, MessageCircle, Upload } from 'lucide-react'
import { getPaymentInfo, uploadPaymentProof } from '../lib/api'
import { Aviso, Boton } from '../components/ui'
import { money } from '../lib/format'
import type { BankAccount, Business, OrderResult, PaymentMethod } from '../lib/types'

// Pedido registrado.
//
// Aquí NO se dice "pagado" ni "confirmado": el negocio cobra por fuera de la
// plataforma (regla inviolable #6). Se muestran los datos para transferir y se
// pide mandar el comprobante por WhatsApp, que es lo que hoy de verdad ocurre.

const lineasBanco = (cuenta: BankAccount) => [
  { etiqueta: 'Banco', valor: cuenta.bank_name },
  { etiqueta: 'Tipo', valor: cuenta.account_type },
  { etiqueta: 'Número', valor: cuenta.account_number, copiable: true },
  { etiqueta: 'Titular', valor: cuenta.holder_name },
  { etiqueta: 'Cédula / RUC', valor: cuenta.holder_id, copiable: true },
].filter(linea => Boolean(linea.valor))

export default function OrderDone({ slug, business, order, resumen, paymentMethod }: {
  slug: string
  business: Business
  order: OrderResult
  resumen: { titulo: string; total: number | null }
  /** Nulo en hospedaje, que no pregunta cómo se paga. */
  paymentMethod?: PaymentMethod | null
}) {
  const [cuenta, setCuenta] = useState<BankAccount | null>(null)
  const [copiado, setCopiado] = useState('')
  const [comprobante, setComprobante] = useState<'ninguno' | 'subiendo' | 'listo'>('ninguno')
  const [falloComprobante, setFalloComprobante] = useState<string | null>(null)
  const archivo = useRef<HTMLInputElement>(null)

  // Solo se piden datos bancarios a quien dijo que iba a transferir. Quien paga
  // en efectivo no tiene por qué ver una cuenta ni un comprobante.
  const vaATransferir = paymentMethod !== 'efectivo'

  useEffect(() => {
    if (!vaATransferir) return
    // Si el negocio no cargó datos bancarios no es un error: simplemente
    // coordinará el pago por WhatsApp como siempre.
    getPaymentInfo(slug).then(setCuenta).catch(() => setCuenta(null))
  }, [slug, vaATransferir])

  // El pedido YA está creado: si esto falla, no se pierde nada y el negocio
  // pedirá el comprobante por WhatsApp. Por eso el fallo se cuenta sin drama.
  const subir = async (elegido: File | undefined) => {
    // Sin id no hay a qué adjuntarlo: se calla y queda el camino de WhatsApp.
    if (!elegido || !order.id) return
    setComprobante('subiendo')
    setFalloComprobante(null)
    try {
      await uploadPaymentProof(slug, order.id, elegido)
      setComprobante('listo')
    } catch (error) {
      setComprobante('ninguno')
      setFalloComprobante(
        error instanceof Error ? error.message : 'No pudimos subir tu comprobante',
      )
    }
  }

  const copiar = async (texto: string) => {
    try {
      await navigator.clipboard.writeText(texto)
      setCopiado(texto)
      setTimeout(() => setCopiado(''), 1800)
    } catch { /* sin portapapeles: el número está a la vista igual */ }
  }

  const numero = order.order_number ? `#${order.order_number}` : ''
  const totalOficial = resumen.total != null
    ? resumen.total
    : Number.parseFloat(String(order.total ?? ''))
  const whatsapp = business.phone
    ? `https://wa.me/${business.phone.replace(/[^\d]/g, '')}?text=${
      encodeURIComponent(`Hola, acabo de enviar mi ${resumen.titulo.toLowerCase()} ${numero} 🙂`)
    }`
    : null

  return (
    <div className="animar-entrada mx-auto min-h-full max-w-md px-5 py-10">
      <div className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-emerald-500/12">
        <CheckCircle2 size={26} className="text-emerald-600 dark:text-emerald-400" />
      </div>

      <h1 className="text-[26px] leading-tight font-extrabold tracking-tight">
        {resumen.titulo} enviado {numero}
      </h1>
      <p className="mt-2.5 text-[15px] leading-relaxed texto-tenue">
        {business.name} lo recibió y te escribe por WhatsApp para confirmarlo.
      </p>

      {Number.isFinite(totalOficial) && (
        <div className="superficie mt-6 flex items-baseline justify-between rounded-2xl border borde-tema px-4 py-4">
          <span className="text-[14px] font-semibold texto-tenue">Total</span>
          <span className="text-[26px] font-extrabold tabular-nums">{money(totalOficial)}</span>
        </div>
      )}

      {vaATransferir && cuenta && lineasBanco(cuenta).length > 0 && (
        <section className="mt-6">
          <h2 className="mb-3 flex items-center gap-2 text-[13px] font-bold tracking-wide uppercase texto-tenue">
            <Landmark size={15} />
            Para transferir
          </h2>
          <div className="superficie divide-y divide-(--linea) overflow-hidden rounded-2xl border borde-tema">
            {lineasBanco(cuenta).map(({ etiqueta, valor, copiable }) => (
              <div key={etiqueta} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="text-[13px] texto-tenue">{etiqueta}</span>
                <span className="flex items-center gap-2 text-right text-[14px] font-semibold">
                  {String(valor)}
                  {copiable && (
                    <button onClick={() => copiar(String(valor))} aria-label={`Copiar ${etiqueta}`}>
                      <Copy size={14} className={copiado === String(valor) ? 'text-marca' : 'texto-tenue'} />
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
          {cuenta.instructions && (
            <p className="mt-2.5 text-[13px] texto-tenue">{cuenta.instructions}</p>
          )}
          {/* ── Comprobante ── */}
          {/* Es opcional a propósito: el pedido ya está hecho. Quien no
              encuentre la foto ahora la manda por WhatsApp y no pierde nada. */}
          <div className="mt-4 space-y-3">
            {!order.id
              ? (
                  <Aviso>
                    Envía el comprobante por WhatsApp para que el negocio lo verifique.
                  </Aviso>
                )
              : comprobante === 'listo'
              ? (
                  <Aviso>
                    <span className="flex items-center gap-2">
                      <CheckCircle2 size={16} />
                      Comprobante recibido. El negocio lo va a verificar.
                    </span>
                  </Aviso>
                )
              : (
                  <>
                    <input
                      ref={archivo}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={event => void subir(event.target.files?.[0])}
                    />
                    <Boton
                      variante="suave"
                      disabled={comprobante === 'subiendo'}
                      onClick={() => archivo.current?.click()}
                    >
                      <span className="flex items-center justify-center gap-2">
                        <Upload size={17} />
                        {comprobante === 'subiendo' ? 'Subiendo…' : 'Subir comprobante'}
                      </span>
                    </Boton>
                    <p className="text-center text-[12px] texto-tenue">
                      También puedes enviarlo por WhatsApp si prefieres.
                    </p>
                  </>
                )}
            {falloComprobante && <Aviso tono="alerta">{falloComprobante}</Aviso>}
          </div>
        </section>
      )}

      {whatsapp && (
        <div className="mt-6">
          <a href={whatsapp} className="block">
            <Boton variante={cuenta ? 'principal' : 'linea'}>
              <span className="flex items-center justify-center gap-2">
                <MessageCircle size={18} />
                Escribir por WhatsApp
              </span>
            </Boton>
          </a>
        </div>
      )}
    </div>
  )
}

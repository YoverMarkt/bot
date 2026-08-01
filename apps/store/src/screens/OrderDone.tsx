import { useEffect, useState } from 'react'
import { CheckCircle2, Copy, Landmark, MessageCircle } from 'lucide-react'
import { getPaymentInfo } from '../lib/api'
import { Aviso, Boton } from '../components/ui'
import { money } from '../lib/format'
import type { BankAccount, Business, OrderResult } from '../lib/types'

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

export default function OrderDone({ slug, business, order, resumen }: {
  slug: string
  business: Business
  order: OrderResult
  resumen: { titulo: string; total: number | null }
}) {
  const [cuenta, setCuenta] = useState<BankAccount | null>(null)
  const [copiado, setCopiado] = useState('')

  useEffect(() => {
    // Si el negocio no cargó datos bancarios no es un error: simplemente
    // coordinará el pago por WhatsApp como siempre.
    getPaymentInfo(slug).then(setCuenta).catch(() => setCuenta(null))
  }, [slug])

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

      {cuenta && lineasBanco(cuenta).length > 0 && (
        <section className="mt-6">
          <h2 className="mb-3 flex items-center gap-2 text-[13px] font-bold tracking-wide uppercase texto-tenue">
            <Landmark size={15} />
            Para transferir
          </h2>
          <div className="superficie divide-y divide-[var(--linea)] overflow-hidden rounded-2xl border borde-tema">
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
          <div className="mt-4">
            <Aviso>
              Envía el comprobante por WhatsApp para que el negocio lo verifique.
            </Aviso>
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

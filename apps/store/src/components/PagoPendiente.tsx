import { useEffect, useRef, useState } from 'react'
import { Copy, Landmark, MessageCircle, Upload } from 'lucide-react'
import { Aviso, Boton } from './ui'
import { getPaymentInfo, uploadPaymentProof } from '../lib/api'
import type { BankAccount } from '../lib/types'

// ── LO QUE FALTA PARA QUE EL PEDIDO ARRANQUE ───────────────────────────────
//
// Los datos para transferir y las dos vías de mandar el comprobante.
//
// Vive junto al «pedido recibido» y NO en el seguimiento: el seguimiento
// cuenta por dónde va el pedido, y mezclarle un formulario de pago lo
// convertía en un cajón. Pagar es lo primero que hay que hacer, así que va en
// la pantalla inmediatamente posterior a confirmar.
//
// ⚠️ Las DOS vías valen igual, y la segunda es un enlace de verdad. No es
// preferencia estética: mucha gente transfiere desde la app de su banco —a
// veces desde la cuenta de un familiar— y la captura le queda en el teléfono
// con el que abrió WhatsApp, no aquí. El enlace lleva escrito el número de
// pedido para que el dueño sepa de cuál le hablan.
//
// ⚠️ NO se fuerza la cámara (`capture`), y es deliberado: el comprobante es
// una captura de pantalla del banco, que vive en la galería. Forzar la cámara
// obligaría a fotografiar la pantalla de otro teléfono.

const lineasBanco = (cuenta: BankAccount) => [
  { etiqueta: 'Banco', valor: cuenta.bank_name },
  { etiqueta: 'Tipo', valor: cuenta.account_type },
  { etiqueta: 'Número', valor: cuenta.account_number, copiable: true },
  { etiqueta: 'Titular', valor: cuenta.holder_name },
  { etiqueta: 'Cédula / RUC', valor: cuenta.holder_id, copiable: true },
].filter(linea => Boolean(linea.valor))

export default function PagoPendiente({
  slug, orderId, orderNumber, telefonoNegocio, onSubido,
}: {
  slug: string
  orderId: string
  orderNumber?: number | string | null
  telefonoNegocio?: string | null
  /** Se avisa al terminar para que quien llame pase al seguimiento. */
  onSubido: () => void
}) {
  const [cuenta, setCuenta] = useState<BankAccount | null>(null)
  const [copiado, setCopiado] = useState('')
  const [estado, setEstado] = useState<'ninguno' | 'subiendo'>('ninguno')
  const [fallo, setFallo] = useState<string | null>(null)
  const archivo = useRef<HTMLInputElement>(null)

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

  const subir = async (elegido: File | undefined) => {
    if (!elegido) return
    setEstado('subiendo')
    setFallo(null)
    try {
      await uploadPaymentProof(slug, orderId, elegido)
      onSubido()
    } catch (error) {
      setEstado('ninguno')
      setFallo(error instanceof Error ? error.message : 'No pudimos subir tu comprobante')
    }
  }

  const filas = cuenta ? lineasBanco(cuenta) : []

  return (
    <section className="w-full text-left">
      <h2 className="mb-3 flex items-center gap-2 text-[13px] font-bold tracking-wide uppercase texto-tenue">
        <Landmark size={15} />
        Para transferir
      </h2>

      {filas.length > 0 && (
        <div className="superficie divide-y divide-(--linea) overflow-hidden rounded-2xl border borde-tema">
          {filas.map(({ etiqueta, valor, copiable }) => (
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
      )}

      <div className="mt-3 space-y-3">
        <input
          ref={archivo}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={event => void subir(event.target.files?.[0])}
        />
        <Boton disabled={estado === 'subiendo'} onClick={() => archivo.current?.click()}>
          <span className="flex items-center justify-center gap-2">
            <Upload size={17} />
            {estado === 'subiendo' ? 'Subiendo…' : 'Subir comprobante'}
          </span>
        </Boton>
        <p className="text-center text-[12.5px] texto-tenue">
          Sube tu comprobante para confirmar tu pedido.
        </p>
        {telefonoNegocio && (
          <a
            href={`https://wa.me/${telefonoNegocio.replace(/[^\d]/g, '')}?text=${
              encodeURIComponent(
                `Hola, te envío el comprobante de mi pedido #${orderNumber ?? ''} 🙂`.replace(' #  ', ' '),
              )
            }`}
            className="flex items-center justify-center gap-1.5 text-center text-[12.5px] font-semibold text-marca"
          >
            <MessageCircle size={14} />
            También puedes enviarlo por WhatsApp
          </a>
        )}
        {fallo && <Aviso tono="alerta">{fallo}</Aviso>}
      </div>
    </section>
  )
}

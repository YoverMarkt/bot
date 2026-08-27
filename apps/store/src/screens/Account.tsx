import { useEffect, useState } from 'react'
import {
  RiArrowLeftSLine,
  RiDeleteBin6Line,
  RiMapPin2Line,
} from '@remixicon/react'
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

// ── El estado se lee, o esta pantalla no sirve para nada ───────────────────
//
// ⚠️ Los estados vivos iban en `text-marca`, el color del negocio como color de
// LETRA. Medido sobre blanco: el verde real de Monster Pizza (`#1BDE60`) da
// **1,80:1** y el lima de la plataforma **1,19:1**, donde AA exige 4,5. O sea
// que «En camino» —el único sitio de la app donde el cliente puede comprobar
// por dónde va lo suyo si el aviso de WhatsApp no llegara— era prácticamente
// invisible. `index.css` ya lo tenía escrito: «un lima sobre blanco no se lee
// al sol», y esta app se abre en la calle.
//
// Ahora el estado es una PASTILLA y el tono dice de quién es el turno:
//
//   · `PILL_ACTIVO`  — el pedido se mueve. Acento SÓLIDO, con el texto
//     calculado por luminancia (`aplicarColorDeMarca`), así que el negocio
//     puede elegir cualquier color sin romper el contraste.
//   · `PILL_ATENCION` — le toca al cliente. Ámbar fijo: «ojo» no es marca, y
//     un negocio no elige el color de lo que le falta a su cliente.
//   · `PILL_QUIETO`  — nada que hacer (recibido, entregado, cancelado).
//
// ⚠️ Sin `dark:`. El ámbar llevaba `dark:text-amber-400` de un modo oscuro que
// esta app no tiene —`color-scheme: light` fijo—, pero la media query SÍ se
// dispara con el teléfono en oscuro: era amber-400 sobre tarjeta blanca.
const PILL_ACTIVO = 'acento shadow-acento'
const PILL_ATENCION = 'bg-amber-50 text-amber-700'
const PILL_QUIETO = 'bg-black/5 texto-cuerpo'

/** Los doce estados internos, dichos como los entiende quien compró. */
const COMO_VA: Record<string, { texto: string; tono: string }> = {
  esperando_pago: { texto: 'Falta tu pago', tono: PILL_ATENCION },
  pago_en_revision: { texto: 'Revisando tu pago', tono: PILL_QUIETO },
  pendiente: { texto: 'Recibido', tono: PILL_QUIETO },
  confirmado: { texto: 'En preparación', tono: PILL_ACTIVO },
  aceptado: { texto: 'En preparación', tono: PILL_ACTIVO },
  preparacion: { texto: 'En preparación', tono: PILL_ACTIVO },
  listo_para_retiro: { texto: 'Listo para retirar', tono: PILL_ACTIVO },
  en_camino: { texto: 'En camino', tono: PILL_ACTIVO },
  completado: { texto: 'Entregado', tono: PILL_QUIETO },
  cancelado: { texto: 'Cancelado', tono: PILL_QUIETO },
  rechazado: { texto: 'Rechazado', tono: PILL_QUIETO },
  expirado: { texto: 'Expirado', tono: PILL_QUIETO },
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
    <div className="mx-auto min-h-dvh max-w-md pb-24">
      {/* ⚠️ `pt-seguro`, no `py-4`. Con `viewport-fit=cover` en el index.html
          la página arranca en el borde FÍSICO de la pantalla, así que esta
          cabecera pegajosa se metía bajo la hora y la batería del iPhone. Es
          el mismo descuido que ya se corrigió en la portada: `pb-seguro`
          existía desde el principio y su pareja de arriba, no. Sin muesca el
          `env()` vale 0 y queda exactamente el aire de antes. */}
      <header className="superficie sticky top-0 z-30 flex items-center gap-2 px-4 pt-seguro pb-4 shadow-tarjeta">
        <button
          onClick={onVolver}
          aria-label="Volver"
          className="-ml-2 flex size-11 shrink-0 items-center justify-center rounded-full transition active:scale-95 active:bg-black/5"
        >
          <RiArrowLeftSLine size={20} />
        </button>
        <h1 className="titulo-l">Mi cuenta</h1>
      </header>

      <div className="space-y-7 px-4 pt-5">
        {me?.phone && (
          <p className="caption texto-cuerpo">
            Tus pedidos y direcciones en este local, ligados a tu WhatsApp {me.phone}.
          </p>
        )}

        {/* ── Mis pedidos ── */}
        <section>
          <h2 className="titulo-l mb-2.5 px-1">
            Mis pedidos
          </h2>

          {error && <Aviso tono="alerta">{error}</Aviso>}

          {/* Esqueleto con la forma de la lista, no una rueda girando: así la
              pantalla no salta cuando llegan los datos. El `brillo` recorre en
              vez de parpadear —un bloque que respira parece algo que viene— y
              se apaga solo con `prefers-reduced-motion`. */}
          {!pedidos && !error && (
            <div className="space-y-2">
              {[0, 1].map(fila => (
                <div key={fila} className="brillo h-17 rounded-(--radius-tarjeta)" />
              ))}
            </div>
          )}

          {pedidos?.length === 0 && (
            <div className="rounded-(--radius-tarjeta) border border-dashed borde-tema px-4 py-8 text-center">
              <p className="titulo-m">Todavía no has pedido nada</p>
              <p className="mt-1.5 text-[13px] texto-cuerpo">
                Cuando hagas tu primer pedido, aparecerá aquí.
              </p>
            </div>
          )}

          <div className="space-y-2">
            {(pedidos || []).map((pedido) => {
              // ⚠️ El pago confirmado MANDA sobre el estado mientras el pedido
              // siga esperando. `payment_confirmed_at` no es un estado —dice
              // algo que pasó, no dónde está el pedido—, así que un pedido
              // cobrado seguía leyéndose «Falta tu pago» hasta que el dueño lo
              // aceptara. El dueño toca «Solo confirmar el pago» precisamente
              // para que el cliente deje de creer que debe dinero.
              const cobrado = Boolean(pedido.payment_confirmed_at)
                && (pedido.status === 'esperando_pago' || pedido.status === 'pago_en_revision')
              const estado = cobrado
                ? { texto: 'Pago confirmado', tono: PILL_ACTIVO }
                : COMO_VA[pedido.status] || { texto: pedido.status, tono: PILL_QUIETO }
              const cuantos = (pedido.order_items || []).length
              return (
                // ⚠️ Sigue siendo un `div`, no un botón: esta fila no lleva a
                // ninguna parte desde que se retiró el seguimiento, y fingir
                // que sí es peor que no ofrecerlo.
                <div
                  key={pedido.id}
                  className="superficie flex w-full items-center gap-3 rounded-(--radius-tarjeta) px-4 py-3.5 text-left shadow-tarjeta"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-[15px] font-extrabold tracking-tight tabular-nums">
                        #{pedido.order_number}
                      </span>
                      <span className={`rounded-full px-2.5 py-1 text-[11.5px] font-bold ${estado.tono}`}>
                        {estado.texto}
                      </span>
                    </span>
                    <span className="mt-1 block text-[12.5px] texto-cuerpo">
                      {cuando(pedido.created_at)}
                      {cuantos > 0 && ` · ${cuantos} ${cuantos === 1 ? 'producto' : 'productos'}`}
                    </span>
                  </span>
                  <span className="shrink-0 text-[16px] font-extrabold tracking-tight tabular-nums">
                    {money(Number(pedido.total) || 0)}
                  </span>
                </div>
              )
            })}
          </div>
        </section>

        {/* ── Mis direcciones ── */}
        <section>
          <h2 className="titulo-l mb-2.5 px-1">
            Mis direcciones
          </h2>

          {direcciones.length === 0 && (
            <div className="rounded-(--radius-tarjeta) border border-dashed borde-tema px-4 py-6 text-center">
              <p className="text-[13px] texto-cuerpo">
                Las direcciones que guardes al pedir aparecerán aquí.
              </p>
            </div>
          )}

          <div className="space-y-2">
            {direcciones.map(direccion => (
              <div
                key={direccion.id}
                className="superficie flex items-center gap-3 rounded-(--radius-tarjeta) px-4 py-3.5 shadow-tarjeta"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-black/5">
                  <RiMapPin2Line size={17} className="texto-cuerpo" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14.5px] font-bold tracking-tight">{direccion.label}</span>
                  <span className="block text-[13px] texto-cuerpo">{direccion.address}</span>
                  {direccion.reference && (
                    <span className="caption block texto-tenue">{direccion.reference}</span>
                  )}
                </span>
                {/* 44×44 reales, como pide el diseño: iba en `p-1.5` sobre un
                    icono de 16, o sea 28 px de diana para una acción que
                    además borra algo. */}
                <button
                  onClick={() => {
                    if (!window.confirm(`¿Eliminar «${direccion.label}»?`)) return
                    void onBorrarDireccion(direccion.id)
                  }}
                  aria-label={`Eliminar ${direccion.label}`}
                  className="-mr-2 flex size-11 shrink-0 items-center justify-center rounded-full texto-cuerpo transition active:scale-90 active:bg-black/5"
                >
                  <RiDeleteBin6Line size={17} />
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

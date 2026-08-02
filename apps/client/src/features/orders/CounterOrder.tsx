// ── PEDIDO DE MOSTRADOR ───────────────────────────────────────────────────
//
// Alguien entra al local, compra y se va. Antes eso vivía en «Registrar venta»,
// un camino aparte que hacía que el dinero entrara de dos formas distintas.
// Ahora es un pedido más: nace entregado y la base le crea su venta sola.
//
// El teléfono es OPCIONAL a propósito: en un mostrador casi nunca se pide, y
// exigirlo llevaría a inventarse números que ensucian el directorio de
// clientes. Sin teléfono, la venta se guarda sin contacto.
//
// Aquí no se calcula dinero que valga: el total que se ve mientras se arma el
// pedido es orientativo, y el oficial lo devuelve el servidor (regla #8).
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Plus, Trash2 } from 'lucide-react'
import { createCounterOrder, getProducts, money } from './api'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Input } from '@botpanel/ui/components/input'
import { Label } from '@botpanel/ui/components/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@botpanel/ui/components/select'

type Linea = { product_id: string; quantity: number }

export default function CounterOrder({ onListo }: { onListo: () => void }) {
  const qc = useQueryClient()
  const [lineas, setLineas] = useState<Linea[]>([])
  const [nombre, setNombre] = useState('')
  const [telefono, setTelefono] = useState('')

  const { data: productos = [] } = useQuery({ queryKey: ['products'], queryFn: getProducts })

  const precio = (id: string) => {
    const producto = productos.find(item => item.id === id)
    if (!producto) return 0
    const oferta = Number(producto.price_sale)
    return oferta > 0 ? oferta : Number(producto.price) || 0
  }

  const estimado = useMemo(
    () => lineas.reduce((suma, linea) => suma + precio(linea.product_id) * linea.quantity, 0),
    [lineas, productos],
  )

  const registrar = useMutation({
    mutationFn: () => createCounterOrder({
      contact_phone: telefono.trim() || null,
      contact_name: nombre.trim() || null,
      items: lineas,
    }),
    onSuccess: (pedido) => {
      toast.success(`Pedido registrado por ${money(pedido.total)} — ya está en tus ventas`)
      setLineas([]); setNombre(''); setTelefono('')
      void qc.invalidateQueries({ queryKey: ['orders'] })
      onListo()
    },
    onError: error => toast.error(
      error instanceof Error ? error.message : 'No se pudo registrar el pedido',
    ),
  })

  const listo = lineas.length > 0 && lineas.every(l => l.product_id && l.quantity > 0)

  return (
    <Card className="p-5 gap-0">
      <h2 className="font-semibold text-foreground">Pedido de mostrador</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Para lo que se vende en persona. Queda entregado y entra directo a tus ventas.
      </p>

      <div className="space-y-2">
        {lineas.map((linea, indice) => (
          <div key={indice} className="flex flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1">
              <Label htmlFor={`producto-${indice}`}>Producto</Label>
              <Select
                value={linea.product_id}
                onValueChange={(valor) => setLineas(actuales => actuales.map(
                  (item, i) => i === indice ? { ...item, product_id: valor } : item,
                ))}
              >
                <SelectTrigger id={`producto-${indice}`}><SelectValue placeholder="Elige…" /></SelectTrigger>
                <SelectContent>
                  {productos.map(producto => (
                    <SelectItem key={producto.id} value={producto.id}>
                      {producto.name} — {money(precio(producto.id))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-24">
              <Label htmlFor={`cantidad-${indice}`}>Cantidad</Label>
              <Input
                id={`cantidad-${indice}`}
                type="number" min="1" max="99"
                value={linea.quantity}
                onChange={(evento) => setLineas(actuales => actuales.map(
                  (item, i) => i === indice
                    ? { ...item, quantity: Math.max(1, Number(evento.target.value) || 1) }
                    : item,
                ))}
              />
            </div>
            <Button
              variant="outline" size="icon"
              aria-label="Quitar línea"
              onClick={() => setLineas(actuales => actuales.filter((_, i) => i !== indice))}
            >
              <Trash2 />
            </Button>
          </div>
        ))}

        <Button
          variant="outline"
          onClick={() => setLineas(actuales => [...actuales, { product_id: '', quantity: 1 }])}
        >
          <Plus /> Agregar producto
        </Button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="mostrador-nombre">Cliente (opcional)</Label>
          <Input
            id="mostrador-nombre" value={nombre}
            onChange={e => setNombre(e.target.value)} placeholder="Nombre"
          />
        </div>
        <div>
          <Label htmlFor="mostrador-telefono">Teléfono (opcional)</Label>
          <Input
            id="mostrador-telefono" value={telefono}
            onChange={e => setTelefono(e.target.value)} placeholder="0999999999"
          />
          <p className="mt-1 text-[11px] text-muted-foreground/80">
            Si lo dejas vacío, la venta queda sin cliente asociado.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
        <span className="text-sm text-muted-foreground">
          Total estimado <span className="font-bold text-foreground">{money(estimado)}</span>
          <span className="ml-2 text-[11px]">— el oficial lo calcula el servidor</span>
        </span>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onListo}>Cancelar</Button>
          <Button disabled={!listo || registrar.isPending} onClick={() => registrar.mutate()}>
            {registrar.isPending ? 'Registrando…' : 'Registrar pedido'}
          </Button>
        </div>
      </div>
    </Card>
  )
}

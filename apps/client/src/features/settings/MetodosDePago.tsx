import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { Label } from '@botpanel/ui/components/label'
import { Checkbox } from '@botpanel/ui/components/checkbox'
import { Skeleton } from '@botpanel/ui/components/skeleton'

// ═══════════════════════════════════════════════════════════════════════════
// CÓMO TE PAGAN
// ═══════════════════════════════════════════════════════════════════════════
//
// Hasta el 2026-08-16 esto era un campo de texto libre que solo alimentaba el
// prompt del bot: el dueño creía que elegía cómo le pagan y la tienda ofrecía
// los tres métodos a todo el mundo. Se notó en los datos — 3 de 43 pedidos se
// pagaron en efectivo sin que nadie lo hubiera activado.
//
// ⚠️ Esta pantalla no decide nada: propone. El servidor comprueba, y un
// disparador en la base rechaza un pedido con un método que el local no
// acepta — eso cierra la carrera entre que la tienda pinta los métodos y el
// cliente confirma.

type MetodoDelNegocio = {
  method_code: string
  enabled: boolean
  payment_methods: {
    label: string
    help_text: string | null
    is_prepaid: boolean
    requires_proof: boolean
  }
}

const getMetodos = () => api<MetodoDelNegocio[]>('/api/client/payment-methods')

const setMetodo = (code: string, enabled: boolean) =>
  api<{ ok: boolean }>(`/api/client/payment-methods/${code}`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })

export default function MetodosDePago() {
  const qc = useQueryClient()
  const { data: metodos = [], isLoading } = useQuery({
    queryKey: ['payment-methods'],
    queryFn: getMetodos,
  })

  const cambiar = useMutation({
    mutationFn: ({ code, enabled }: { code: string, enabled: boolean }) => setMetodo(code, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payment-methods'] }),
  })

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Label>Cómo te pagan</Label>
        <Skeleton className="h-9 w-full" />
      </div>
    )
  }

  return (
    <div>
      <Label>Cómo te pagan</Label>
      <div className="mt-2 space-y-2 rounded-md border p-3">
        {metodos.map(m => (
          <div key={m.method_code} className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-foreground">{m.payment_methods.label}</p>
              {m.payment_methods.help_text && (
                <p className="text-[11px] text-muted-foreground/80">{m.payment_methods.help_text}</p>
              )}
            </div>
            <Checkbox
              id={`metodo-${m.method_code}`}
              checked={m.enabled}
              disabled={cambiar.isPending}
              aria-label={`${m.enabled ? 'Desactivar' : 'Activar'} ${m.payment_methods.label}`}
              onCheckedChange={valor => cambiar.mutate({
                code: m.method_code,
                enabled: valor === true,
              })}
            />
          </div>
        ))}
      </div>

      {cambiar.isError && (
        <p className="mt-1 text-[11px] text-destructive">
          {(cambiar.error as Error).message}
        </p>
      )}

      <p className="mt-1 text-[11px] text-muted-foreground/80">
        Solo aparecen en tu tienda los que dejes activos. Tiene que quedar al menos uno.
      </p>
    </div>
  )
}

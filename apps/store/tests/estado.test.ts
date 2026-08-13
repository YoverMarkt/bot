import { describe, expect, it } from 'vitest'
import { esEstadoFinal, estaCancelado } from '../src/lib/estado'

// La pantalla de «pedido recibido» dice «¡Gracias!» y no consulta nada. Si el
// dueño cancela, ese agradecimiento pasa a ser mentira y el cliente se queda
// esperando comida que no se está haciendo.

describe('¿murió el pedido?', () => {
  it('los tres finales sin entrega cuentan como cancelado', () => {
    for (const status of ['cancelado', 'rechazado', 'expirado']) {
      expect(estaCancelado(status), status).toBe(true)
    }
  })

  // Un pedido entregado NO es un pedido cancelado, por obvio que parezca:
  // meterlos en el mismo saco pintaría «Pedido cancelado» sobre uno que llegó.
  it('entregado no es cancelado', () => {
    expect(estaCancelado('completado')).toBe(false)
  })

  it('los estados en marcha no cancelan nada', () => {
    for (const status of [
      'pendiente', 'esperando_pago', 'pago_en_revision', 'confirmado',
      'aceptado', 'preparacion', 'listo_para_retiro', 'en_camino',
    ]) {
      expect(estaCancelado(status), status).toBe(false)
    }
  })

  it('un estado vacío o desconocido no cancela: ante la duda, el pedido sigue', () => {
    for (const status of [null, undefined, '', '   ', 'lo_que_sea']) {
      expect(estaCancelado(status)).toBe(false)
    }
  })

  it('no se fía de mayúsculas ni espacios sueltos', () => {
    expect(estaCancelado(' Cancelado ')).toBe(true)
    expect(estaCancelado('RECHAZADO')).toBe(true)
  })
})

describe('¿queda algo que esperar?', () => {
  // Seguir preguntando cada 30 segundos por algo que ya no puede cambiar es
  // gastar los datos del cliente para nada.
  it('los finales cierran la consulta, incluido el entregado', () => {
    for (const status of ['cancelado', 'rechazado', 'expirado', 'completado']) {
      expect(esEstadoFinal(status), status).toBe(true)
    }
  })

  it('un pedido en marcha se sigue mirando', () => {
    for (const status of ['esperando_pago', 'preparacion', 'en_camino']) {
      expect(esEstadoFinal(status), status).toBe(false)
    }
  })
})

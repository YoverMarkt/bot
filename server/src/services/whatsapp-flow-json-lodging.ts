type JsonRecord = Record<string, unknown>

const optionSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
    },
  },
} as const

const exampleOptions = (id: string, title: string) => ({
  ...optionSchema,
  __example__: [{ id, title }],
})

/**
 * Flow vertical de hospedaje. Fechas, huéspedes, inventario y dinero se
 * resuelven siempre mediante data_exchange; el JSON no incrusta datos de un
 * tenant ni acepta un total calculado por el teléfono.
 */
export function buildLodgingFlowJson(): JsonRecord {
  return {
    version: '7.3',
    data_api_version: '3.0',
    routing_model: {
      LODGING_DATES: ['LODGING_GUESTS'],
      LODGING_GUESTS: ['LODGING_OPTIONS', 'LODGING_DETAILS'],
      LODGING_OPTIONS: ['LODGING_REVIEW'],
      LODGING_DETAILS: ['LODGING_REVIEW'],
      LODGING_REVIEW: [],
    },
    screens: [
      {
        id: 'LODGING_DATES',
        title: 'Fechas de hospedaje',
        data: {
          business_name: { type: 'string', __example__: 'Hostal Vista Andina' },
          min_date: { type: 'string', __example__: '2026-07-28' },
          max_date: { type: 'string', __example__: '2028-07-27' },
          error_message: { type: 'string', __example__: '' },
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [{
            type: 'Form',
            name: 'lodging_dates_form',
            children: [
              {
                type: 'TextHeading',
                text: '${data.business_name}',
              },
              {
                type: 'TextBody',
                text: 'Elige la fecha de entrada y la fecha de salida.',
              },
              {
                type: 'DatePicker',
                label: 'Entrada',
                name: 'check_in',
                required: true,
                'min-date': '${data.min_date}',
                'max-date': '${data.max_date}',
              },
              {
                type: 'DatePicker',
                label: 'Salida',
                name: 'check_out',
                required: true,
                'min-date': '${data.min_date}',
                'max-date': '${data.max_date}',
              },
              {
                type: 'TextCaption',
                text: '${data.error_message}',
              },
              {
                type: 'Footer',
                label: 'Continuar',
                'on-click-action': {
                  name: 'data_exchange',
                  payload: {
                    intent: 'continue_lodging_dates',
                    check_in: '${form.check_in}',
                    check_out: '${form.check_out}',
                  },
                },
              },
            ],
          }],
        },
      },
      {
        id: 'LODGING_GUESTS',
        title: 'Huéspedes',
        data: {
          check_in: { type: 'string', __example__: '2026-08-01' },
          check_out: { type: 'string', __example__: '2026-08-03' },
          stay_summary: {
            type: 'string',
            __example__: 'Entrada: 2026-08-01 · Salida: 2026-08-03',
          },
          error_message: { type: 'string', __example__: '' },
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [{
            type: 'Form',
            name: 'lodging_guests_form',
            children: [
              {
                type: 'TextSubheading',
                text: '${data.stay_summary}',
              },
              {
                type: 'TextInput',
                'input-type': 'number',
                label: 'Adultos',
                name: 'adults',
                required: true,
                'min-chars': 1,
                'max-chars': 3,
                'helper-text': 'Entre 1 y 100.',
              },
              {
                type: 'TextInput',
                'input-type': 'number',
                label: 'Niños',
                name: 'children',
                required: true,
                'min-chars': 1,
                'max-chars': 3,
                'helper-text': 'Escribe 0 si no viajan niños.',
              },
              {
                type: 'TextInput',
                'input-type': 'number',
                label: 'Habitaciones mínimas',
                name: 'rooms_count',
                required: true,
                'min-chars': 1,
                'max-chars': 3,
                'helper-text': 'El sistema aumentará la cantidad si el grupo lo necesita.',
              },
              {
                type: 'TextCaption',
                text: '${data.error_message}',
              },
              {
                type: 'Footer',
                label: 'Ver disponibilidad',
                'on-click-action': {
                  name: 'data_exchange',
                  payload: {
                    intent: 'quote_lodging',
                    check_in: '${data.check_in}',
                    check_out: '${data.check_out}',
                    adults: '${form.adults}',
                    children: '${form.children}',
                    rooms_count: '${form.rooms_count}',
                  },
                },
              },
            ],
          }],
        },
      },
      {
        id: 'LODGING_OPTIONS',
        title: 'Habitaciones',
        data: {
          stay_summary: {
            type: 'string',
            __example__: '2 noches · 2 adultos · 1 niño',
          },
          quote_expires_label: {
            type: 'string',
            __example__: 'Cotización válida por tiempo limitado.',
          },
          room_options: exampleOptions(
            '00000000-0000-4000-8000-000000000001',
            'Cabaña · 1 hab. · $120.00',
          ),
          manual_notice: { type: 'string', __example__: '' },
          error_message: { type: 'string', __example__: '' },
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [{
            type: 'Form',
            name: 'lodging_options_form',
            children: [
              {
                type: 'TextSubheading',
                text: '${data.stay_summary}',
              },
              {
                type: 'Dropdown',
                label: 'Habitación disponible',
                name: 'room_type_id',
                required: true,
                'data-source': '${data.room_options}',
              },
              {
                type: 'TextInput',
                'input-type': 'text',
                label: 'Nombre del huésped',
                name: 'contact_name',
                required: true,
                'max-chars': 120,
              },
              {
                type: 'TextArea',
                label: 'Notas del hospedaje',
                name: 'notes',
                required: false,
                'max-length': 1000,
              },
              {
                type: 'TextCaption',
                text: '${data.quote_expires_label}',
              },
              {
                type: 'TextCaption',
                text: '${data.manual_notice}',
              },
              {
                type: 'TextCaption',
                text: '${data.error_message}',
              },
              {
                type: 'Footer',
                label: 'Revisar solicitud',
                'on-click-action': {
                  name: 'data_exchange',
                  payload: {
                    intent: 'review_lodging',
                    room_type_id: '${form.room_type_id}',
                    contact_name: '${form.contact_name}',
                    notes: '${form.notes}',
                  },
                },
              },
            ],
          }],
        },
      },
      {
        id: 'LODGING_DETAILS',
        title: 'Completa tus datos',
        data: {
          room_type_id: {
            type: 'string',
            __example__: '00000000-0000-4000-8000-000000000001',
          },
          chosen_room_summary: {
            type: 'string',
            __example__: 'Cabaña Familiar · 1 habitación · $120.00',
          },
          quote_expires_label: {
            type: 'string',
            __example__: 'Cotización válida por tiempo limitado.',
          },
          error_message: { type: 'string', __example__: '' },
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [{
            type: 'Form',
            name: 'lodging_details_form',
            children: [
              {
                type: 'TextBody',
                text: '${data.chosen_room_summary}',
              },
              {
                type: 'TextBody',
                text: 'Conservamos la habitación que elegiste. Completa los datos para revisar la solicitud.',
              },
              {
                type: 'TextInput',
                'input-type': 'text',
                label: 'Nombre del huésped',
                name: 'contact_name',
                required: true,
                'max-chars': 120,
              },
              {
                type: 'TextArea',
                label: 'Notas del hospedaje',
                name: 'notes',
                required: false,
                'max-length': 1000,
              },
              {
                type: 'TextCaption',
                text: '${data.quote_expires_label}',
              },
              {
                type: 'TextCaption',
                text: '${data.error_message}',
              },
              {
                type: 'Footer',
                label: 'Revisar solicitud',
                'on-click-action': {
                  name: 'data_exchange',
                  payload: {
                    intent: 'review_lodging',
                    room_type_id: '${data.room_type_id}',
                    contact_name: '${form.contact_name}',
                    notes: '${form.notes}',
                  },
                },
              },
            ],
          }],
        },
      },
      {
        id: 'LODGING_REVIEW',
        title: 'Revisa tu solicitud',
        terminal: true,
        success: true,
        data: {
          flow_token: { type: 'string', __example__: 'opaque-token' },
          summary: {
            type: 'string',
            __example__: 'Cabaña Familiar\n2 noches · 2 adultos\n1 habitación',
          },
          total: { type: 'string', __example__: '$120.00' },
          notice: {
            type: 'string',
            __example__: 'La solicitud quedará pendiente de confirmación.',
          },
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            {
              type: 'TextHeading',
              text: 'Resumen',
            },
            {
              type: 'TextBody',
              text: '${data.summary}',
            },
            {
              type: 'TextSubheading',
              text: 'Total oficial: ${data.total}',
            },
            {
              type: 'TextCaption',
              text: '${data.notice}',
            },
            {
              type: 'Footer',
              label: 'Enviar solicitud',
              'on-click-action': {
                name: 'complete',
                payload: {
                  flow_token: '${data.flow_token}',
                },
              },
            },
          ],
        },
      },
    ],
  }
}

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
 * Flow vertical de citas. Las opciones reales nunca se incrustan en el JSON:
 * el endpoint data_exchange resuelve servicio, fecha y hora para el tenant de
 * la sesión. "Confirmar" aquí significa confirmar el envío de la solicitud;
 * la cita queda pendiente de aprobación por el negocio.
 */
export function buildAppointmentFlowJson(): JsonRecord {
  return {
    version: '7.3',
    data_api_version: '3.0',
    routing_model: {
      APPOINTMENT_SERVICE: ['APPOINTMENT_DATE'],
      APPOINTMENT_DATE: ['APPOINTMENT_TIME'],
      APPOINTMENT_TIME: ['APPOINTMENT_DETAILS'],
      APPOINTMENT_DETAILS: ['APPOINTMENT_REVIEW'],
      APPOINTMENT_REVIEW: [],
    },
    screens: [
      {
        id: 'APPOINTMENT_SERVICE',
        title: 'Solicita una cita',
        data: {
          business_name: { type: 'string', __example__: 'Mi negocio' },
          services: exampleOptions(
            '00000000-0000-4000-8000-000000000001',
            'Corte de cabello · 45 min',
          ),
          error_message: { type: 'string', __example__: '' },
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [{
            type: 'Form',
            name: 'appointment_service_form',
            children: [
              {
                type: 'TextHeading',
                text: '${data.business_name}',
              },
              {
                type: 'Dropdown',
                label: 'Servicio',
                name: 'service_id',
                required: true,
                'data-source': '${data.services}',
              },
              {
                type: 'TextCaption',
                text: '${data.error_message}',
              },
              {
                type: 'Footer',
                label: 'Elegir fecha',
                'on-click-action': {
                  name: 'data_exchange',
                  payload: {
                    intent: 'select_service',
                    service_id: '${form.service_id}',
                  },
                },
              },
            ],
          }],
        },
      },
      {
        id: 'APPOINTMENT_DATE',
        title: 'Elige una fecha',
        data: {
          service_name: { type: 'string', __example__: 'Corte de cabello' },
          dates: exampleOptions('2099-01-15', 'Jue. 15 ene.'),
          error_message: { type: 'string', __example__: '' },
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [{
            type: 'Form',
            name: 'appointment_date_form',
            children: [
              {
                type: 'TextBody',
                text: '${data.service_name}',
              },
              {
                type: 'Dropdown',
                label: 'Fecha disponible',
                name: 'booking_date',
                required: true,
                'data-source': '${data.dates}',
              },
              {
                type: 'TextCaption',
                text: '${data.error_message}',
              },
              {
                type: 'Footer',
                label: 'Elegir hora',
                'on-click-action': {
                  name: 'data_exchange',
                  payload: {
                    intent: 'select_date',
                    booking_date: '${form.booking_date}',
                  },
                },
              },
            ],
          }],
        },
      },
      {
        id: 'APPOINTMENT_TIME',
        title: 'Elige una hora',
        data: {
          service_name: { type: 'string', __example__: 'Corte de cabello' },
          date_label: { type: 'string', __example__: 'Jue. 15 ene.' },
          times: exampleOptions('09:00', '09:00'),
          error_message: { type: 'string', __example__: '' },
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [{
            type: 'Form',
            name: 'appointment_time_form',
            children: [
              {
                type: 'TextBody',
                text: '${data.service_name} · ${data.date_label}',
              },
              {
                type: 'Dropdown',
                label: 'Hora disponible',
                name: 'booking_time',
                required: true,
                'data-source': '${data.times}',
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
                    intent: 'select_time',
                    booking_time: '${form.booking_time}',
                  },
                },
              },
            ],
          }],
        },
      },
      {
        id: 'APPOINTMENT_DETAILS',
        title: 'Tus datos',
        data: {
          appointment_summary: {
            type: 'string',
            __example__: 'Corte de cabello · 15/01/2099 · 09:00',
          },
          error_message: { type: 'string', __example__: '' },
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [{
            type: 'Form',
            name: 'appointment_details_form',
            children: [
              {
                type: 'TextBody',
                text: '${data.appointment_summary}',
              },
              {
                type: 'TextInput',
                'input-type': 'text',
                label: 'Nombre completo',
                name: 'contact_name',
                required: true,
                'max-chars': 120,
              },
              {
                type: 'TextArea',
                label: 'Notas al negocio',
                name: 'notes',
                required: false,
                'max-length': 500,
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
                    intent: 'review_appointment',
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
        id: 'APPOINTMENT_REVIEW',
        title: 'Revisa tu solicitud',
        terminal: true,
        success: true,
        data: {
          flow_token: { type: 'string', __example__: 'opaque-token' },
          service_id: {
            type: 'string',
            __example__: '00000000-0000-4000-8000-000000000001',
          },
          service_name: { type: 'string', __example__: 'Corte de cabello' },
          booking_date: { type: 'string', __example__: '2099-01-15' },
          booking_time: { type: 'string', __example__: '09:00' },
          contact_name: { type: 'string', __example__: 'Cliente' },
          notes: { type: 'string', __example__: '' },
          request_status: { type: 'string', __example__: 'pending' },
          summary: {
            type: 'string',
            __example__: 'Corte de cabello · 15/01/2099 · 09:00',
          },
          pending_notice: {
            type: 'string',
            __example__: 'El negocio revisará y confirmará tu solicitud.',
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
              type: 'TextBody',
              text: '${data.pending_notice}',
            },
            {
              type: 'Footer',
              label: 'Enviar solicitud',
              'on-click-action': {
                name: 'complete',
                payload: {
                  flow_token: '${data.flow_token}',
                  service_id: '${data.service_id}',
                  service_name: '${data.service_name}',
                  booking_date: '${data.booking_date}',
                  booking_time: '${data.booking_time}',
                  contact_name: '${data.contact_name}',
                  notes: '${data.notes}',
                  request_status: 'pending',
                },
              },
            },
          ],
        },
      },
    ],
  }
}

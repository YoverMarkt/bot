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

const textData = (example = '') => ({
  type: 'string',
  __example__: example,
})

/**
 * Flow genérico para captar una solicitud sin incrustar datos de ningún
 * negocio. El nombre y los temas se entregan desde el endpoint dinámico.
 */
export function buildLeadFlowJson(): JsonRecord {
  return {
    version: '7.3',
    data_api_version: '3.0',
    routing_model: {
      LEAD_DETAILS: ['LEAD_REVIEW'],
      LEAD_REVIEW: [],
    },
    screens: [
      {
        id: 'LEAD_DETAILS',
        title: 'Cuéntanos qué necesitas',
        data: {
          business_name: textData('Nuestro negocio'),
          topics: {
            ...optionSchema,
            __example__: [{ id: 'informacion', title: 'Información' }],
          },
          contact_name: textData(),
          topic_id: textData(),
          details: textData(),
          email: textData(),
          preferred_time: textData(),
          error_message: textData(),
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [{
            type: 'Form',
            name: 'lead_details_form',
            children: [
              {
                type: 'TextHeading',
                text: '${data.business_name}',
              },
              {
                type: 'TextInput',
                'input-type': 'text',
                label: 'Tu nombre',
                name: 'contact_name',
                required: true,
                'max-chars': 120,
                'init-value': '${data.contact_name}',
              },
              {
                type: 'Dropdown',
                label: '¿Sobre qué necesitas ayuda?',
                name: 'topic_id',
                required: true,
                'data-source': '${data.topics}',
                'init-value': '${data.topic_id}',
              },
              {
                type: 'TextArea',
                label: 'Describe tu pedido',
                name: 'details',
                required: true,
                'max-length': 1000,
                'init-value': '${data.details}',
              },
              {
                type: 'TextInput',
                'input-type': 'email',
                label: 'Correo (opcional)',
                name: 'email',
                required: false,
                'max-chars': 254,
                'init-value': '${data.email}',
              },
              {
                type: 'TextInput',
                'input-type': 'text',
                label: 'Horario (opcional)',
                name: 'preferred_time',
                required: false,
                'max-chars': 120,
                'init-value': '${data.preferred_time}',
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
                    intent: 'review_lead',
                    contact_name: '${form.contact_name}',
                    topic_id: '${form.topic_id}',
                    details: '${form.details}',
                    email: '${form.email}',
                    preferred_time: '${form.preferred_time}',
                  },
                },
              },
            ],
          }],
        },
      },
      {
        id: 'LEAD_REVIEW',
        title: 'Revisa tu solicitud',
        terminal: true,
        success: true,
        data: {
          flow_token: textData('opaque-token'),
          contact_name: textData('Cliente'),
          topic_id: textData('informacion'),
          topic_label: textData('Información'),
          details: textData('Necesito más información.'),
          email: textData(),
          preferred_time: textData(),
          summary: textData('Información solicitada'),
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            {
              type: 'TextHeading',
              text: '${data.topic_label}',
            },
            {
              type: 'TextBody',
              text: '${data.summary}',
            },
            {
              type: 'Footer',
              label: 'Enviar solicitud',
              'on-click-action': {
                name: 'complete',
                payload: {
                  flow_token: '${data.flow_token}',
                  contact_name: '${data.contact_name}',
                  topic_id: '${data.topic_id}',
                  topic_label: '${data.topic_label}',
                  details: '${data.details}',
                  email: '${data.email}',
                  preferred_time: '${data.preferred_time}',
                },
              },
            },
          ],
        },
      },
    ],
  }
}

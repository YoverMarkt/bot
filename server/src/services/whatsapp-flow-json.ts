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

function itemScreen(
  id: 'ORDER_ITEM_ONE' | 'ORDER_ITEM_TWO' | 'ORDER_ITEM_THREE',
  position: number,
): JsonRecord {
  const canAddAnother = position < 3
  const positionName = ['one', 'two', 'three'][position - 1]
  return {
    id,
    title: `Producto ${position}`,
    data: {
      categories: exampleOptions('pizzas', 'Pizzas'),
      products: exampleOptions('00000000-0000-4000-8000-000000000001', 'Pizza mediana'),
      modifiers: exampleOptions('none', 'Sin variante'),
      cart_summary: {
        type: 'string',
        __example__: 'Tu pedido todavía está vacío.',
      },
      error_message: { type: 'string', __example__: '' },
    },
    layout: {
      type: 'SingleColumnLayout',
      children: [{
        type: 'Form',
        name: `item_${positionName}_form`,
        children: [
          {
            type: 'TextBody',
            text: '${data.cart_summary}',
          },
          {
            type: 'Dropdown',
            label: 'Categoría',
            name: 'category_id',
            required: true,
            'data-source': '${data.categories}',
            'on-select-action': {
              name: 'data_exchange',
              payload: {
                intent: 'load_products',
                item_position: position,
                category_id: '${form.category_id}',
              },
            },
          },
          {
            type: 'Dropdown',
            label: 'Producto o tamaño',
            name: 'product_id',
            required: true,
            'data-source': '${data.products}',
          },
          {
            type: 'Dropdown',
            label: 'Sabor u opción',
            name: 'modifier_id',
            required: true,
            'data-source': '${data.modifiers}',
          },
          {
            type: 'TextInput',
            'input-type': 'number',
            label: 'Cantidad',
            name: 'quantity',
            required: true,
            'min-chars': 1,
            'max-chars': 2,
          },
          {
            type: 'TextInput',
            'input-type': 'text',
            label: 'Nota del producto',
            name: 'item_note',
            required: false,
            'max-chars': 240,
          },
          ...(canAddAnother ? [{
            type: 'RadioButtonsGroup',
            label: '¿Deseas agregar otro producto?',
            name: 'next_step',
            required: true,
            'data-source': [
              { id: 'add_more', title: 'Sí, agregar otro' },
              { id: 'finish_items', title: 'No, continuar' },
            ],
          }] : []),
          {
            type: 'TextCaption',
            text: '${data.error_message}',
          },
          {
            type: 'Footer',
            label: canAddAnother ? 'Guardar producto' : 'Continuar',
            'on-click-action': {
              name: 'data_exchange',
              payload: {
                intent: 'save_item',
                item_position: position,
                category_id: '${form.category_id}',
                product_id: '${form.product_id}',
                modifier_id: '${form.modifier_id}',
                quantity: '${form.quantity}',
                item_note: '${form.item_note}',
                next_step: canAddAnother ? '${form.next_step}' : 'finish_items',
              },
            },
          },
        ],
      }],
    },
  }
}

/**
 * Primer Flow vertical real. Los catálogos y totales no se incrustan: el
 * endpoint dinámico los carga desde la base del negocio en cada sesión.
 */
export function buildOrderFlowJson(): JsonRecord {
  return {
    version: '7.3',
    data_api_version: '3.0',
    routing_model: {
      ORDER_METHOD: ['ORDER_ITEM_ONE'],
      ORDER_ITEM_ONE: ['ORDER_ITEM_TWO', 'ORDER_DETAILS'],
      ORDER_ITEM_TWO: ['ORDER_ITEM_THREE', 'ORDER_DETAILS'],
      ORDER_ITEM_THREE: ['ORDER_DETAILS'],
      ORDER_DETAILS: ['ORDER_REVIEW'],
      ORDER_REVIEW: [],
    },
    screens: [
      {
        id: 'ORDER_METHOD',
        title: 'Arma tu pedido',
        data: {
          business_name: { type: 'string', __example__: 'Mi negocio' },
          fulfillment_options: exampleOptions('delivery', 'Entrega a domicilio'),
          error_message: { type: 'string', __example__: '' },
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [{
            type: 'Form',
            name: 'method_form',
            children: [
              {
                type: 'TextHeading',
                text: '${data.business_name}',
              },
              {
                type: 'RadioButtonsGroup',
                label: 'Entrega o retiro',
                name: 'fulfillment',
                required: true,
                'data-source': '${data.fulfillment_options}',
              },
              {
                type: 'TextCaption',
                text: '${data.error_message}',
              },
              {
                type: 'Footer',
                label: 'Elegir productos',
                'on-click-action': {
                  name: 'data_exchange',
                  payload: {
                    intent: 'start_order',
                    fulfillment: '${form.fulfillment}',
                  },
                },
              },
            ],
          }],
        },
      },
      itemScreen('ORDER_ITEM_ONE', 1),
      itemScreen('ORDER_ITEM_TWO', 2),
      itemScreen('ORDER_ITEM_THREE', 3),
      {
        id: 'ORDER_DETAILS',
        title: 'Entrega y pago',
        data: {
          fulfillment: { type: 'string', __example__: 'delivery' },
          payment_methods: exampleOptions('cash', 'Efectivo'),
          items_json: { type: 'string', __example__: '[]' },
          cart_summary: { type: 'string', __example__: '1 × Pizza mediana' },
          error_message: { type: 'string', __example__: '' },
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [{
            type: 'Form',
            name: 'details_form',
            children: [
              { type: 'TextBody', text: '${data.cart_summary}' },
              {
                type: 'TextInput',
                'input-type': 'text',
                label: 'Nombre',
                name: 'contact_name',
                required: true,
                'max-chars': 120,
              },
              {
                type: 'TextInput',
                'input-type': 'text',
                label: 'Dirección de entrega',
                name: 'address',
                required: false,
                'max-chars': 500,
              },
              {
                type: 'TextInput',
                'input-type': 'text',
                label: 'Referencia',
                name: 'address_reference',
                required: false,
                'max-chars': 500,
              },
              {
                type: 'Dropdown',
                label: 'Método de pago',
                name: 'payment_method',
                required: true,
                'data-source': '${data.payment_methods}',
              },
              {
                type: 'TextInput',
                'input-type': 'text',
                label: 'Hora deseada',
                name: 'requested_for',
                required: false,
                'max-chars': 80,
              },
              {
                type: 'TextArea',
                label: 'Notas generales',
                name: 'notes',
                required: false,
                'max-length': 1000,
              },
              { type: 'TextCaption', text: '${data.error_message}' },
              {
                type: 'Footer',
                label: 'Revisar pedido',
                'on-click-action': {
                  name: 'data_exchange',
                  payload: {
                    intent: 'review_order',
                    fulfillment: '${data.fulfillment}',
                    items_json: '${data.items_json}',
                    contact_name: '${form.contact_name}',
                    address: '${form.address}',
                    address_reference: '${form.address_reference}',
                    payment_method: '${form.payment_method}',
                    requested_for: '${form.requested_for}',
                    notes: '${form.notes}',
                  },
                },
              },
            ],
          }],
        },
      },
      {
        id: 'ORDER_REVIEW',
        title: 'Confirma tu pedido',
        terminal: true,
        success: true,
        data: {
          flow_token: { type: 'string', __example__: 'opaque-token' },
          fulfillment: { type: 'string', __example__: 'delivery' },
          items_json: { type: 'string', __example__: '[]' },
          contact_name: { type: 'string', __example__: 'Cliente' },
          address: { type: 'string', __example__: 'Dirección' },
          address_reference: { type: 'string', __example__: '' },
          payment_method: { type: 'string', __example__: 'cash' },
          requested_for: { type: 'string', __example__: '' },
          notes: { type: 'string', __example__: '' },
          summary: { type: 'string', __example__: '1 × Pizza mediana' },
          total: { type: 'string', __example__: '$10.00' },
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextHeading', text: 'Resumen' },
            { type: 'TextBody', text: '${data.summary}' },
            { type: 'TextSubheading', text: 'Total oficial: ${data.total}' },
            {
              type: 'Footer',
              label: 'Confirmar pedido',
              'on-click-action': {
                name: 'complete',
                payload: {
                  flow_token: '${data.flow_token}',
                  fulfillment: '${data.fulfillment}',
                  items_json: '${data.items_json}',
                  contact_name: '${data.contact_name}',
                  address: '${data.address}',
                  address_reference: '${data.address_reference}',
                  payment_method: '${data.payment_method}',
                  requested_for: '${data.requested_for}',
                  notes: '${data.notes}',
                },
              },
            },
          ],
        },
      },
    ],
  }
}

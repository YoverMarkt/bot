import { describe, expect, it, vi } from 'vitest'
import { createLodgingService, LodgingServiceError } from '../dist/services/lodging.js'

function database(overrides = {}) {
  return {
    createLodgingQuote: vi.fn(),
    getLatestLodgingQuote: vi.fn(),
    createLodgingRequest: vi.fn(),
    ...overrides,
  }
}

const quoteInput = {
  businessId: 'business-a',
  contactPhone: '+593999000001',
  contactName: 'Ana',
  checkIn: '2026-12-24',
  checkOut: '2026-12-27',
  adults: 2,
  children: 1,
  roomsCount: 2,
}

const automaticOption = {
  room_type_id: 'room-type-a',
  name: 'Habitación familiar',
  description: 'Baño privado',
  max_guests: 4,
  available_units: 3,
  units_required: 1,
  pricing_model: 'base_plus_extra',
  currency: 'USD',
  prices_include_tax: true,
  check_in_time: '16:00:00',
  check_out_time: '10:30:00',
  subtotal: '105.00',
  tax: '12.60',
  fees: '2.00',
  total: '119.60',
  amenities: ['WiFi', 'Desayuno'],
  media_urls: ['https://cdn.example.com/familiar.jpg'],
  nightly_rates: [{ date: '2026-12-24', total: '35.00' }],
}

describe('servicio oficial de hospedaje', () => {
  it('normaliza la cotización calculada por PostgreSQL sin recalcular dinero', async () => {
    const db = database({
      createLodgingQuote: vi.fn().mockResolvedValue({
        data: {
          result: 'quoted',
          quote: {
            id: 'quote-a',
            check_in: quoteInput.checkIn,
            check_out: quoteInput.checkOut,
            adults: 2,
            children: 1,
            rooms_count: 2,
            check_in_time: '16:00:00',
            check_out_time: '10:30:00',
            nights: 3,
            expires_at: '2026-12-24T10:15:00Z',
          },
          options: [automaticOption],
        },
        error: null,
      }),
    })
    const service = createLodgingService(db)

    const result = await service.quoteLodging(quoteInput)

    expect(result).toEqual({
      quoteId: 'quote-a',
      checkIn: '2026-12-24',
      checkOut: '2026-12-27',
      checkInTime: '16:00',
      checkOutTime: '10:30',
      adults: 2,
      children: 1,
      roomsCount: 2,
      nights: 3,
      expiresAt: '2026-12-24T10:15:00Z',
      options: [{
        roomTypeId: 'room-type-a',
        name: 'Habitación familiar',
        description: 'Baño privado',
        maxGuests: 4,
        availableUnits: 3,
        unitsRequired: 1,
        pricingModel: 'base_plus_extra',
        currency: 'USD',
        pricesIncludeTax: true,
        subtotal: 105,
        tax: 12.6,
        fees: 2,
        total: 119.6,
        amenities: ['WiFi', 'Desayuno'],
        mediaUrls: ['https://cdn.example.com/familiar.jpg'],
        nightlyRates: [{ date: '2026-12-24', total: '35.00' }],
        summary: {
          checkIn: '2026-12-24',
          checkOut: '2026-12-27',
          nights: 3,
          adults: 2,
          children: 1,
          guests: 3,
          roomsCount: 2,
          unitsRequired: 1,
        },
      }],
    })
    expect(db.createLodgingQuote).toHaveBeenCalledWith(expect.objectContaining({
      business_id: 'business-a',
      contact_phone: '+593999000001',
      check_in: '2026-12-24',
      check_out: '2026-12-27',
      rooms_count: 2,
    }))
  })

  it('conserva importes nulos cuando el precio requiere revisión humana', async () => {
    const db = database({
      createLodgingQuote: vi.fn().mockResolvedValue({
        data: {
          result: 'quoted',
          quote: {
            id: 'quote-manual', nights: 3,
            check_in: quoteInput.checkIn, check_out: quoteInput.checkOut,
            adults: 2, children: 1, expires_at: '2026-12-24T10:15:00Z',
          },
          options: [{
            ...automaticOption,
            pricing_model: 'manual',
            subtotal: null,
            tax: null,
            fees: null,
            total: null,
          }],
        },
      }),
    })

    const result = await createLodgingService(db).quoteLodging(quoteInput)

    expect(result.options[0]).toMatchObject({
      pricingModel: 'manual', subtotal: null, tax: null, fees: null, total: null,
    })
  })

  it('no expone inventario cerrado aunque la fila conserve unidades físicas', async () => {
    const db = database({
      createLodgingQuote: vi.fn().mockResolvedValue({
        data: {
          result: 'quoted',
          quote: {
            id: 'quote-closed', nights: 3,
            check_in: quoteInput.checkIn, check_out: quoteInput.checkOut,
            adults: 2, children: 1, expires_at: '2026-12-24T10:15:00Z',
          },
          options: [{
            ...automaticOption,
            closed: true,
            available_units: 3,
            image_url: 'https://cdn.example.com/legacy.jpg',
            nightly_rates: undefined,
            nightly_breakdown: [{ date: '2026-12-24', line_total: 35 }],
          }],
        },
      }),
    })

    const result = await createLodgingService(db).quoteLodging(quoteInput)

    expect(result.options[0]).toMatchObject({
      availableUnits: 0,
      nightlyRates: [{ date: '2026-12-24', line_total: 35 }],
    })
    expect(result.options[0].mediaUrls).toContain('https://cdn.example.com/legacy.jpg')
  })

  it('rechaza rangos y huéspedes inválidos antes de consultar la base', async () => {
    const db = database()
    const service = createLodgingService(db)

    await expect(service.quoteLodging({
      ...quoteInput,
      checkOut: quoteInput.checkIn,
    })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(service.quoteLodging({
      ...quoteInput,
      adults: 0,
    })).rejects.toBeInstanceOf(LodgingServiceError)
    expect(db.createLodgingQuote).not.toHaveBeenCalled()
  })

  it('crea el hold con la última cotización del mismo negocio y contacto', async () => {
    const db = database({
      getLatestLodgingQuote: vi.fn().mockResolvedValue({
        id: 'quote-a',
        business_id: 'business-a',
        contact_phone: '+593999000001',
        check_in: '2026-12-24',
        check_out: '2026-12-27',
        adults: 2,
        children: 1,
        nights: 3,
        expires_at: '2099-12-24T10:15:00Z',
        options: [automaticOption],
      }),
      createLodgingRequest: vi.fn().mockResolvedValue({
        data: {
          result: 'created',
          request: {
            id: 'request-a',
            quote_id: 'quote-a',
            room_type_id: 'room-type-a',
            room_type_name: 'Habitación familiar',
            status: 'pending_owner',
            check_in: '2026-12-24',
            check_out: '2026-12-27',
            adults: 2,
            children: 1,
            nights: 3,
            units_required: 1,
            currency: 'USD',
            subtotal: '105.00',
            tax: '12.60',
            fees: '2.00',
            total: '119.60',
            expires_at: '2099-12-24T11:00:00Z',
          },
        },
      }),
    })
    const service = createLodgingService(db)

    const result = await service.requestLodging({
      businessId: 'business-a',
      contactPhone: '+593999000001',
      contactName: 'Ana',
      roomTypeName: 'habitacion familiar',
    })

    expect(result).toEqual({
      ok: true,
      request: expect.objectContaining({
        requestId: 'request-a',
        quoteId: 'quote-a',
        roomTypeId: 'room-type-a',
        status: 'pending_owner',
        total: 119.6,
      }),
    })
    expect(db.getLatestLodgingQuote).toHaveBeenCalledWith(
      'business-a',
      '+593999000001',
    )
    expect(db.createLodgingRequest).toHaveBeenCalledWith(expect.objectContaining({
      business_id: 'business-a',
      quote_id: 'quote-a',
      room_type_id: 'room-type-a',
      idempotency_key: expect.stringMatching(/^[0-9a-f]{64}$/),
    }))
  })

  it.each([
    {
      name: 'cotización vencida',
      quote: { id: 'quote-a', expires_at: '2020-01-01T00:00:00Z', options: [] },
      expected: 'quote_expired',
    },
    {
      name: 'precio manual',
      quote: {
        id: 'quote-a', expires_at: '2099-01-01T00:00:00Z',
        options: [{ ...automaticOption, pricing_model: 'manual' }],
      },
      expected: 'manual_quote',
      roomTypeId: 'room-type-a',
    },
  ])('no crea hold ante $name', async ({ quote, expected, roomTypeId }) => {
    const db = database({ getLatestLodgingQuote: vi.fn().mockResolvedValue(quote) })

    const result = await createLodgingService(db).requestLodging({
      businessId: 'business-a',
      contactPhone: '+593999000001',
      roomTypeId,
    })

    expect(result).toMatchObject({ ok: false, error: { code: expected } })
    expect(db.createLodgingRequest).not.toHaveBeenCalled()
  })

  it('convierte un conflicto transaccional en unavailable sin filtrar PostgreSQL', async () => {
    const db = database({
      getLatestLodgingQuote: vi.fn().mockResolvedValue({
        id: 'quote-a', expires_at: '2099-01-01T00:00:00Z',
        options: [automaticOption],
      }),
      createLodgingRequest: vi.fn().mockResolvedValue({
        data: { result: 'unavailable' }, error: null,
      }),
    })

    const result = await createLodgingService(db).requestLodging({
      businessId: 'business-a',
      contactPhone: '+593999000001',
      roomTypeId: 'room-type-a',
    })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'unavailable',
        message: 'La opción elegida ya no tiene disponibilidad para todas las noches.',
      },
    })
  })
})

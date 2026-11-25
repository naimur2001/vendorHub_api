import { z } from 'zod';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const page = z.coerce.number().int().min(1).default(1);
const limit = z.coerce.number().int().min(1).max(100).default(20);
const courierId = z.coerce.number().int().positive();

export const idParam = z.object({ id: courierId });

export const reportQuery = z
  .object({ from: day.optional(), to: day.optional(), providerId: z.uuid().optional(), shopId: z.uuid().optional() })
  .refine((o) => !o.from || !o.to || o.from <= o.to, { message: '"from" must not be after "to"', path: ['from'] });

export const timeseriesQuery = reportQuery.and(z.object({ interval: z.enum(['day']).default('day') }));

const shipmentStatus = z.enum([
  'PENDING',
  'BOOKED',
  'PICKUP_ASSIGNED',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED',
  'RETURNING',
  'RETURNED',
  'CANCELLED',
]);

export const shipmentsQuery = z.object({
  status: shipmentStatus.optional(),
  providerId: z.uuid().optional(),
  shopId: z.uuid().optional(),
  q: z.string().trim().min(2).max(60).optional(),
  stuck: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  from: day.optional(),
  to: day.optional(),
  page,
  limit,
});

export const quoteQuery = z.object({ addressId: z.uuid() });

export const deliveryModeSchema = z.object({ deliveryMode: z.enum(['OWN', 'PLATFORM_COURIER']) }).strict();

// all three or none
export const courierLocation = {
  courierCityId: courierId,
  courierZoneId: courierId,
  courierAreaId: courierId,
};
export const courierStoreSchema = z
  .object({ courierCityId: courierId.optional(), courierZoneId: courierId.optional(), courierAreaId: courierId.optional() })
  .strict()
  .refine((o) => [o.courierCityId, o.courierZoneId, o.courierAreaId].every((v) => v === undefined) || [o.courierCityId, o.courierZoneId, o.courierAreaId].every((v) => v !== undefined), {
    message: 'Send courierCityId, courierZoneId and courierAreaId together',
  });

export const providerUpdateSchema = z
  .object({
    isActive: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    sandbox: z.boolean().optional(),
    config: z
      .object({
        deliveryType: z.union([z.literal(48), z.literal(12)]).optional(),
        itemType: z.union([z.literal(1), z.literal(2)]).optional(),
        itemWeight: z.number().min(0.1).max(30).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to update' });

const zoneFields = {
  name: z.string().trim().min(2).max(60),
  customerFee: z.number().int().min(0).max(5000),
  etaText: z.string().trim().min(1).max(60),
  isActive: z.boolean(),
  courierCityIds: z.array(courierId).max(100),
  courierZoneIds: z.array(courierId).max(500),
};
export const zoneCreateSchema = z
  .object({
    code: z.enum(['INSIDE_DHAKA', 'DHAKA_SUBURB', 'OUTSIDE_DHAKA']),
    ...zoneFields,
    isActive: zoneFields.isActive.default(true),
    courierCityIds: zoneFields.courierCityIds.default([]),
    courierZoneIds: zoneFields.courierZoneIds.default([]),
  })
  .strict();
export const zoneUpdateSchema = z
  .object({
    name: zoneFields.name.optional(),
    customerFee: zoneFields.customerFee.optional(),
    etaText: zoneFields.etaText.optional(),
    isActive: zoneFields.isActive.optional(),
    courierCityIds: zoneFields.courierCityIds.optional(),
    courierZoneIds: zoneFields.courierZoneIds.optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to update' });

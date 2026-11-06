import { z } from 'zod';

const availability = z.enum(['IN_STOCK', 'LIMITED', 'AVAILABLE', 'OUT_OF_STOCK']);

// Plain text only: trimmed, length-limited. Specs: at most 20 string entries.
const specs = z
  .record(z.string().trim().min(1).max(40), z.string().trim().min(1).max(100))
  .refine((o) => Object.keys(o).length <= 20, { message: 'At most 20 specs' });

export const similarQuery = z.object({
  title: z.string().trim().min(2).max(200),
});

const listingInput = z
  .object({
    price: z.number().int().min(1),
    stockQty: z.number().int().min(0).max(100000).nullable().optional(),
    availability: availability.optional(),
    bargainEnabled: z.boolean().default(false),
    minOfferPercent: z.number().int().min(50).max(100).default(92),
  })
  .strict()
  .refine((l) => !(l.availability && l.stockQty !== null && l.stockQty !== undefined), {
    message: 'Give availability only when stockQty is empty',
    path: ['availability'],
  });

export const createShopProductSchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    categoryId: z.string().uuid(),
    brandId: z.string().uuid().nullable().optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    specs: specs.optional(),
    msrp: z.number().int().min(0).nullable().optional(),
    listing: listingInput,
  })
  .strict();

export const updateShopProductSchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    categoryId: z.string().uuid().optional(),
    brandId: z.string().uuid().nullable().optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    specs: specs.optional(),
    msrp: z.number().int().min(0).nullable().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to update' });
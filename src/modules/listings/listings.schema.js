import { z } from 'zod';

const availability = z.enum(['IN_STOCK', 'LIMITED', 'AVAILABLE', 'OUT_OF_STOCK']);

export const createListingSchema = z.object({
  productId: z.string().uuid(),
  price: z.number().int().min(1),
  availability: availability.optional(), // derived from stockQty if omitted
  stockQty: z.number().int().min(0).nullable().optional(),
  bargainEnabled: z.boolean().default(false),
  minOfferPercent: z.number().int().min(50).max(100).default(92),
  lowStockAt: z.number().int().min(0).max(10000).nullable().optional(), // default 3; null = no alert
});

// GET /shops/:shopId/listings?lowStock=true: only listings at or below their lowStockAt
export const listListingsQuery = z.object({
  lowStock: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

// Written out explicitly (no .partial()) so defaults never overwrite fields on PATCH.
export const updateListingSchema = z
  .object({
    price: z.number().int().min(1).optional(),
    availability: availability.optional(),
    stockQty: z.number().int().min(0).nullable().optional(),
    bargainEnabled: z.boolean().optional(),
    minOfferPercent: z.number().int().min(50).max(100).optional(),
    isActive: z.boolean().optional(),
    lowStockAt: z.number().int().min(0).max(10000).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to update' });
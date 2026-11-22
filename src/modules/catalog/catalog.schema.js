import { z } from 'zod';
import { optionalPoint, bothOrNeither } from '../../lib/geo.js';

export const listProductsQuery = z.object({
  q: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(), // category slug (includes its children)
  brand: z.string().trim().min(1).optional(), // brand name
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  shopId: z.string().uuid().optional(),
  marketId: z.string().uuid().optional(),
  availableOnly: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  sort: z.enum(['newest', 'price_asc', 'price_desc']).default('newest'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

// ?lat=&lng= (optional, both or neither): each listing gets distanceKm to its shop's market
export const productDetailQuery = z
  .object({
    listingId: z.string().uuid().optional(),
    ...optionalPoint,
  })
  .refine(...bothOrNeither);
export const productListingsQuery = z.object({ ...optionalPoint }).refine(...bothOrNeither);
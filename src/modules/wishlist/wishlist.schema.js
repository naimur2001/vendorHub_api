import { z } from 'zod';

export const addWishlistSchema = z.object({ listingId: z.uuid() });

export const listWishlistQuery = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const listingIdParam = z.uuid();

export const productIdParams = z.object({ productId: z.uuid() });

import { z } from 'zod';
import { chosenOptionsSchema } from '../../lib/listingOptions.js';

export const addItemSchema = z.object({
  listingId: z.string().uuid(),
  quantity: z.number().int().min(1).max(10).default(1),
  options: chosenOptionsSchema.optional(), // { "Size": "M" }: required when the listing has variations
});

export const updateItemSchema = z.object({
  quantity: z.number().int().min(1).max(10),
});

export const cartQuery = z.object({
  addressId: z.string().uuid().optional(), // each shop's delivery fee to this saved address
});

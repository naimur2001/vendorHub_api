import { z } from 'zod';

export const addItemSchema = z.object({
  listingId: z.string().uuid(),
  quantity: z.number().int().min(1).max(10).default(1),
});

export const updateItemSchema = z.object({
  quantity: z.number().int().min(1).max(10),
});

export const cartQuery = z.object({
  addressId: z.string().uuid().optional(), // each shop's delivery fee to this saved address
});

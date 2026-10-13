import { z } from 'zod';

export const addItemSchema = z.object({
  listingId: z.string().uuid(),
  quantity: z.number().int().min(1).max(10).default(1),
});

export const updateItemSchema = z.object({
  quantity: z.number().int().min(1).max(10),
});
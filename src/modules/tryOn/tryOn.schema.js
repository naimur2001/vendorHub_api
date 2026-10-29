import { z } from 'zod';

// In rolling order: the slider shows them left to right and starts on FRONT.
export const VIEWS = ['LEFT', 'LEFT_45', 'FRONT', 'RIGHT_45', 'RIGHT'];

export const tryOnQuery = z.object({
  productId: z.string().uuid(),
  view: z.enum(VIEWS),
});

export const toggleSchema = z.object({
  enabled: z.boolean(),
});
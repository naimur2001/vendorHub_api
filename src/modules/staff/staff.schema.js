import { z } from 'zod';

export const addStaffSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  title: z.string().trim().max(60).optional(),
});
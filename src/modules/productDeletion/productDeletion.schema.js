import { z } from 'zod';
import { PRODUCT_DELETION_REASON_MAX } from '../../config/limits.js';

const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const deletionRequestSchema = z
  .object({ reason: optionalText(PRODUCT_DELETION_REASON_MAX) })
  .strict();

export const rejectSchema = z
  .object({ note: z.string().trim().min(3).max(PRODUCT_DELETION_REASON_MAX) })
  .strict();

const status = z.enum(['PENDING', 'REJECTED', 'CANCELLED', 'DONE']);
const page = z.coerce.number().int().min(1).default(1);
const limit = z.coerce.number().int().min(1).max(100).default(20);

export const adminListQuery = z.object({ status: status.optional(), page, limit });
export const shopListQuery = z.object({ status: status.optional(), page, limit });

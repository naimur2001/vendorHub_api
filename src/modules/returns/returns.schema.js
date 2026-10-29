import { z } from 'zod';

const statuses = ['REQUESTED', 'REJECTED', 'ESCALATED', 'REFUNDED', 'CLOSED'];
const page = z.coerce.number().int().min(1).default(1);
const limit = z.coerce.number().int().min(1).max(50).default(20);

export const createReturnSchema = z.object({
  reason: z.enum(['DEFECTIVE', 'WRONG_ITEM', 'NOT_AS_DESCRIBED', 'CHANGED_MIND', 'OTHER']),
  description: z.string().trim().min(10).max(1000),
});

export const listReturnsQuery = z.object({
  status: z.enum(statuses).optional(),
  orderId: z.string().uuid().optional(),
  page,
  limit,
});

export const shopReturnsQuery = z.object({
  status: z.enum(statuses).optional(),
  page,
  limit,
});

export const respondSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    note: z.string().trim().min(5).max(500).optional(),
    restock: z.boolean().default(false),
  })
  .refine((d) => d.decision !== 'REJECT' || d.note, {
    message: 'A note is required when rejecting a return',
    path: ['note'],
  });
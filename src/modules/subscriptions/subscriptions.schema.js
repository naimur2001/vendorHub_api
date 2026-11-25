import { z } from 'zod';
import { MODULES } from '../../lib/entitlements.js';

const PERIOD = z.enum(['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY']);
const STATUS = z.enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED', 'FREE']);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const limit = z.number().int().min(0).max(100000).nullable();
const page = z.coerce.number().int().min(1).default(1);
const perPage = z.coerce.number().int().min(1).max(100).default(20);
const text = (max) => z.string().trim().min(1).max(max);

export const settingsSchema = z
  .object({
    subscriptionsEnabled: z.boolean().optional(),
    freeTrialDays: z.number().int().min(0).max(365).optional(),
    graceDays: z.number().int().min(0).max(90).optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one setting' });

const planFields = {
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,30}$/, 'Use 2-30 letters, digits or _'),
  nameEn: z.string().trim().min(2).max(60),
  nameBn: z.string().trim().min(1).max(60),
  descriptionEn: z.string().trim().max(500).nullable(),
  descriptionBn: z.string().trim().max(500).nullable(),
  modules: z.array(z.enum(MODULES)).max(MODULES.length).refine((a) => new Set(a).size === a.length, 'Each module once'),
  maxProducts: limit,
  maxStaff: limit,
  maxActiveDeals: limit,
  isPublished: z.boolean(),
  isActive: z.boolean(),
  sortOrder: z.number().int().min(0).max(1000),
};
export const planCreateSchema = z
  .object({
    ...planFields,
    descriptionEn: planFields.descriptionEn.optional(),
    descriptionBn: planFields.descriptionBn.optional(),
    modules: planFields.modules.default([]),
    maxProducts: limit.optional(),
    maxStaff: limit.optional(),
    maxActiveDeals: limit.optional(),
    isPublished: planFields.isPublished.default(false),
    isActive: planFields.isActive.default(true),
    sortOrder: planFields.sortOrder.default(0),
  })
  .strict();
export const planUpdateSchema = z
  .object(Object.fromEntries(Object.entries(planFields).map(([k, v]) => [k, v.optional()])))
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to update' });

export const pricesSchema = z
  .object({
    prices: z
      .array(z.object({ period: PERIOD, amount: z.number().int().min(0).max(1000000), isActive: z.boolean().default(true) }).strict())
      .max(4)
      .refine((a) => new Set(a.map((p) => p.period)).size === a.length, 'One price per period'),
  })
  .strict();

export const listQuery = z.object({
  status: STATUS.optional(),
  planId: z.uuid().optional(),
  period: PERIOD.optional(),
  q: z.string().trim().min(2).max(60).optional(),
  expiringInDays: z.coerce.number().int().min(1).max(365).optional(),
  unpaid: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  history: z.enum(['true', 'false']).optional().transform((v) => v === 'true'), // also ended rows
  page,
  limit: perPage,
});

export const startSchema = z
  .object({
    planId: z.uuid(),
    period: PERIOD,
    startsAt: z.coerce.date().optional(),
    trialDays: z.number().int().min(0).max(365).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export const updateSchema = z
  .object({
    cancelAtPeriodEnd: z.boolean().optional(),
    status: z.enum(['ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED']).optional(),
    note: z.string().trim().max(500).nullable().optional(),
    extendDays: z.number().int().min(1).max(365).optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to update' });

export const paymentSchema = z
  .object({
    amount: z.number().int().min(0).max(1000000),
    method: z.enum(['MANUAL_BKASH', 'MANUAL_NAGAD', 'CASH', 'BANK', 'ONLINE']),
    reference: z.string().trim().max(100).optional(),
    paidAt: z.coerce.date().optional(),
  })
  .strict();

export const refundSchema = z.object({ note: z.string().trim().max(500).optional() }).strict();

export const summaryQuery = z
  .object({ from: day.optional(), to: day.optional() })
  .refine((o) => !o.from || !o.to || o.from <= o.to, { message: '"from" must not be after "to"', path: ['from'] });

export const usageQuery = z.object({ moduleCode: z.enum(MODULES).optional() });

export const requestSchema = z.object({ planId: z.uuid(), period: PERIOD }).strict();
export const requestsQuery = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).default('PENDING'), page, limit: perPage });
export const approveSchema = z
  .object({ startsAt: z.coerce.date().optional(), trialDays: z.number().int().min(0).max(365).optional(), note: z.string().trim().max(500).optional() })
  .strict();
export const rejectSchema = z.object({ note: text(500) }).strict();

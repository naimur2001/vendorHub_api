import { z } from 'zod';
import { TOLET_MESSAGE_MAX, ADMIN_NOTE_MAX } from '../../config/limits.js';

const bdPhone = z.string().trim().regex(/^01[3-9]\d{8}$/, 'Use a Bangladesh mobile number like 01712345678');
const email = z.string().trim().toLowerCase().email().max(200);
const taka = z.number().int().min(0).max(100_000_000);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const text = (max) => z.string().trim().min(1).max(max);
const STATUSES = ['PENDING_EMAIL', 'SUBMITTED', 'NEEDS_INFO', 'PUBLISHED', 'RENTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN'];

// the place and the terms (shared by create and edit)
const details = {
  marketId: z.string().uuid().nullable().optional(),
  marketName: z.string().trim().min(2).max(120).nullable().optional(),
  levelFloor: z.string().trim().max(40).nullable().optional(),
  shopNumber: z.string().trim().max(40).nullable().optional(),
  addressLine: z.string().trim().min(5).max(300),
  sizeSqft: z.number().int().min(10).max(1_000_000),
  monthlyRent: taka.refine((n) => n > 0, 'The rent must be more than 0'),
  advance: taka,
  availableFrom: day,
  suitableFor: z.array(z.string().uuid()).max(10).optional(),
  description: z.string().trim().min(10).max(1500),
};

export const createToLetSchema = z
  .object({
    ...details,
    // contact (private): required for guests; a logged-in user's profile fills what is missing
    contactName: z.string().trim().min(2).max(80).optional(),
    contactPhone: bdPhone.optional(),
    contactEmail: email.optional(),
  })
  .strict()
  .refine((o) => o.marketId || o.marketName, { message: 'Choose a market or type its name', path: ['marketId'] });

export const updateToLetSchema = z
  .object({
    marketId: details.marketId,
    marketName: details.marketName,
    levelFloor: details.levelFloor,
    shopNumber: details.shopNumber,
    addressLine: details.addressLine.optional(),
    sizeSqft: details.sizeSqft.optional(),
    monthlyRent: details.monthlyRent.optional(),
    advance: details.advance.optional(),
    availableFrom: details.availableFrom.optional(),
    suitableFor: details.suitableFor,
    description: details.description.optional(),
    contactName: z.string().trim().min(2).max(80).optional(),
    contactPhone: bdPhone.optional(), // the email cannot change (it was confirmed)
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to update' });

export const confirmEmailSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/, 'Invalid token') });
export const manageQuery = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/, 'Invalid token') });

export const listToLetQuery = z
  .object({
    marketId: z.string().uuid().optional(),
    minRent: z.coerce.number().int().min(0).optional(),
    maxRent: z.coerce.number().int().min(0).optional(),
    minSize: z.coerce.number().int().min(0).optional(),
    maxSize: z.coerce.number().int().min(0).optional(),
    q: z.string().trim().min(2).max(100).optional(),
    sort: z.enum(['newest', 'rent_asc', 'rent_desc']).default('newest'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(12),
  })
  .refine((o) => o.minRent === undefined || o.maxRent === undefined || o.minRent <= o.maxRent, { message: 'minRent is above maxRent', path: ['minRent'] })
  .refine((o) => o.minSize === undefined || o.maxSize === undefined || o.minSize <= o.maxSize, { message: 'minSize is above maxSize', path: ['minSize'] });

export const inquirySchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    phone: bdPhone,
    email: email.optional(),
    message: z.string().trim().min(5).max(TOLET_MESSAGE_MAX),
  })
  .strict();

export const messageSchema = z.object({ body: text(TOLET_MESSAGE_MAX) }).strict();
export const messagesQuery = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/, 'Invalid token').optional() });

// ---------- admin ----------
export const adminListQuery = z.object({
  status: z.enum(STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const requestInfoSchema = z.object({ message: text(TOLET_MESSAGE_MAX) }).strict();
export const rejectSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export const noteSchema = z.object({ body: text(ADMIN_NOTE_MAX) }).strict();
export const inquiryStatusSchema = z.object({ status: z.enum(['NEW', 'IN_TALKS', 'CONNECTED', 'CLOSED']) }).strict();

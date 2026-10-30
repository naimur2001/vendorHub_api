import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const phone = z.string().trim().regex(/^01\d{9}$/, 'Use a Bangladesh mobile number like 01712345678');

export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    phone: phone.nullable().optional(),
    avatarUrl: z.string().url().max(500).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to update' });

export const addressSchema = z.object({
  label: z.string().trim().max(40).optional(),
  line1: z.string().trim().min(5).max(200),
  area: z.string().trim().max(100).optional(),
  city: z.string().trim().min(2).max(60).default('Dhaka'),
  phone,
  isDefault: z.boolean().default(false),
});

// Written out explicitly (no .partial()) so defaults never overwrite fields on PATCH.
export const addressUpdateSchema = z
  .object({
    label: z.string().trim().max(40).nullable().optional(),
    line1: z.string().trim().min(5).max(200).optional(),
    area: z.string().trim().max(100).nullable().optional(),
    city: z.string().trim().min(2).max(60).optional(),
    phone: phone.optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to update' });

export const adminUsersQuery = z.object({
  q: z.string().trim().min(1).optional(),
  role: z.enum(['CUSTOMER', 'SHOP_OWNER', 'SHOP_STAFF', 'ADMIN']).optional(),
  isActive: bool.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const userStatusSchema = z.object({
  isActive: z.boolean(),
  reason: z.string().trim().min(5).max(500),
});

export const userRoleSchema = z.object({
  role: z.enum(['CUSTOMER', 'SHOP_OWNER', 'SHOP_STAFF', 'ADMIN']),
  reason: z.string().trim().min(5).max(500),
});
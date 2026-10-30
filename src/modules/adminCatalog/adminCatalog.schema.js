import { z } from 'zod';

const nonEmpty = (o) => Object.keys(o).length > 0;
const nonEmptyMsg = { message: 'Provide at least one field to update' };

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

// ---------- categories ----------
export const categorySchema = z.object({
  name: z.string().trim().min(2).max(80),
  parentId: z.string().uuid().nullable().optional(),
});

export const categoryUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    parentId: z.string().uuid().nullable().optional(),
  })
  .refine(nonEmpty, nonEmptyMsg);

// ---------- brands ----------
export const brandSchema = z.object({ name: z.string().trim().min(2).max(80) });

// ---------- markets ----------
export const marketSchema = z.object({
  name: z.string().trim().min(2).max(100),
  city: z.string().trim().min(2).max(60).default('Dhaka'),
  address: z.string().trim().max(200).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

export const marketUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    city: z.string().trim().min(2).max(60).optional(),
    address: z.string().trim().max(200).nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
  })
  .refine(nonEmpty, nonEmptyMsg);

// ---------- products ----------
export const productSchema = z.object({
  title: z.string().trim().min(3).max(200),
  categoryId: z.string().uuid(),
  brandId: z.string().uuid().nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  specs: z.record(z.string(), z.unknown()).optional(),
  msrp: z.number().int().min(0).nullable().optional(),
  images: z.array(z.string().url().max(500)).max(10).default([]),
});

// Written out explicitly (no .partial()) so defaults never overwrite fields on PATCH.
export const productUpdateSchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    categoryId: z.string().uuid().optional(),
    brandId: z.string().uuid().nullable().optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    specs: z.record(z.string(), z.unknown()).optional(),
    msrp: z.number().int().min(0).nullable().optional(),
    images: z.array(z.string().url().max(500)).max(10).optional(),
    isActive: z.boolean().optional(),
  })
  .refine(nonEmpty, nonEmptyMsg);

export const adminProductsQuery = z.object({
  q: z.string().trim().min(1).optional(),
  categoryId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
  isActive: bool.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
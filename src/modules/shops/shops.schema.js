import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
};

export const shopProductsQuery = z.object({
  q: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(), // category slug (includes children)
  sort: z.enum(['newest', 'price_asc', 'price_desc']).default('newest'),
  bargainOnly: bool.optional(),
  availableOnly: bool.optional(),
  ...pagination,
});

export const shopReviewsQuery = z.object({
  type: z.enum(['PRODUCT', 'SHOP_TRUST']).optional(),
  ...pagination,
});

export const createShopSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(1000).optional(),
  marketId: z.string().uuid().optional(),
  levelFloor: z.string().trim().max(30).optional(),
  shopNumber: z.string().trim().max(30).optional(),
  addressLine: z.string().trim().min(5).max(200),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  supportsDelivery: z.boolean().default(true),
  supportsPickup: z.boolean().default(true),
});

//Only the owner or an admin can edit the shop profile. Staff can manage listings but not the profile. The schema uses .strict(), so a body containing verificationLevel, ownerId, or slug is rejected with a 400 instead of silently ignored. That prevents an owner from verifying their own shop.

export const updateShopSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    logoUrl: z.string().url().nullable().optional(),
    bannerUrl: z.string().url().nullable().optional(),
    marketId: z.string().uuid().nullable().optional(),
    levelFloor: z.string().trim().max(30).nullable().optional(),
    shopNumber: z.string().trim().max(30).nullable().optional(),
    addressLine: z.string().trim().min(5).max(200).optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    supportsDelivery: z.boolean().optional(),
    supportsPickup: z.boolean().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to update' });
import { z } from 'zod';

const statuses = ['AWAITING_SHOP', 'COUNTERED', 'ACCEPTED', 'DECLINED', 'EXPIRED'];

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
};

export const createBargainSchema = z.object({
  listingId: z.string().uuid(),
  offer: z.number().int().min(1),
});

export const amountSchema = z.object({
  amount: z.number().int().min(1),
});

export const listBargainsQuery = z.object({
  status: z.enum(statuses).optional(),
  ...pagination,
});

export const shopInboxQuery = z.object({
  status: z.enum([...statuses, 'ALL']).default('AWAITING_SHOP'),
  ...pagination,
});
import { z } from 'zod';
import { optText, optDate, optBool, linkUrl, blankToNull } from '../banners/banners.schema.js';

// Multipart sends every field as text (like banners): "" clears an optional field.
const optInt = (min, max) => z.preprocess(blankToNull, z.coerce.number().int().min(min).max(max).optional());
const fields = {
  titleBn: optText(120),
  bodyEn: optText(500),
  bodyBn: optText(500),
  linkUrl,
  ctaLabelEn: optText(40),
  ctaLabelBn: optText(40),
  isActive: optBool,
  startsAt: optDate,
  endsAt: optDate,
  priority: optInt(0, 1000),
  audience: z.enum(['ALL', 'GUESTS', 'CUSTOMERS', 'SHOP_TEAM']).optional(),
  pages: z.enum(['HOME_ONLY', 'ALL_PAGES']).optional(),
  frequency: z.enum(['ONCE_PER_VISITOR', 'ONCE_PER_DAY', 'EVERY_VISIT']).optional(),
  delaySeconds: optInt(0, 30),
};
const datesInOrder = (b) => !(b.startsAt && b.endsAt) || b.endsAt > b.startsAt;
const DATES = { message: 'endsAt must be after startsAt', path: ['endsAt'] };

export const createPopupSchema = z.object({ titleEn: z.string().trim().min(1).max(120), ...fields }).refine(datesInOrder, DATES);
export const updatePopupSchema = z
  .object({ titleEn: z.string().trim().min(1).max(120).optional(), removeMobileMedia: optBool, ...fields })
  // like banners: unknown multipart fields are ignored
  .refine(datesInOrder, DATES);

export const activeQuery = z.object({
  page: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{1,40}$/, 'A page key like "home"').default('home'),
  lang: z.enum(['en', 'bn']).optional(),
});
export const eventSchema = z.object({ type: z.enum(['VIEW', 'CLOSE', 'CLICK']) }).strict();
export const settingsSchema = z.object({ popupsEnabled: z.boolean() }).strict();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const statsQuery = z
  .object({ from: day.optional(), to: day.optional() })
  .refine((o) => !o.from || !o.to || o.from <= o.to, { message: '"from" must not be after "to"', path: ['from'] });

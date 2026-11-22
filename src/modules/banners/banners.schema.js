import { z } from 'zod';

// Multipart sends every field as text: "" clears an optional field, "true"/"false" are booleans.
const blankToNull = (v) => (v === '' ? null : v);
const optText = (max) => z.preprocess(blankToNull, z.string().trim().max(max).nullable().optional());
const optDate = z.preprocess(blankToNull, z.coerce.date().nullable().optional());
const optBool = z.preprocess(
  (v) => (v === 'true' ? true : v === 'false' ? false : v),
  z.boolean().optional(),
);
const optOrder = z.coerce.number().int().min(0).max(10000).optional();

// An internal path ("/markets/x", never "//host") or an https URL. Anything else
// (javascript:, data:, http:, relative paths) is refused.
const INTERNAL_PATH = /^\/(?!\/)[^\s\\]*$/;
const isSafeLink = (s) => {
  if (INTERNAL_PATH.test(s)) return true;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && Boolean(u.hostname) && !/\s/.test(s);
  } catch {
    return false;
  }
};
const linkUrl = z.preprocess(
  blankToNull,
  z
    .string()
    .trim()
    .max(500)
    .refine(isSafeLink, { message: 'linkUrl must be a path starting with "/" or an https:// URL' })
    .nullable()
    .optional(),
);

const fields = {
  titleBn: optText(120),
  subtitleEn: optText(200),
  subtitleBn: optText(200),
  linkUrl,
  ctaLabelEn: optText(40),
  ctaLabelBn: optText(40),
  sortOrder: optOrder,
  fit: z.enum(['COVER', 'CONTAIN']).optional(), // how the slide shows the image
  placement: z.enum(['HERO', 'SIDE_AD']).optional(), // the slider or the side advertisement
  isActive: optBool,
  startsAt: optDate,
  endsAt: optDate,
};

const datesInOrder = (b) => !(b.startsAt && b.endsAt) || b.endsAt > b.startsAt;
const DATES_MESSAGE = { message: 'endsAt must be after startsAt', path: ['endsAt'] };

export const createBannerSchema = z
  .object({ titleEn: z.string().trim().min(1).max(120), ...fields })
  .refine(datesInOrder, DATES_MESSAGE);

export const updateBannerSchema = z
  .object({ titleEn: z.string().trim().min(1).max(120).optional(), removeMobileMedia: optBool, ...fields })
  .refine(datesInOrder, DATES_MESSAGE);

export const reorderSchema = z.object({
  ids: z
    .array(z.uuid())
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Each banner can appear only once' }),
});

export const bannerId = z.uuid();

export const PLACEMENTS = ['HERO', 'SIDE_AD'];
// public: the slider unless asked otherwise
export const publicListQuery = z.object({ placement: z.enum(PLACEMENTS).default('HERO') });
// admin: all placements unless filtered
export const adminListQuery = z.object({ placement: z.enum(PLACEMENTS).optional() });

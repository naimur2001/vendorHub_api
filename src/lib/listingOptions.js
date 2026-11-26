// Product variations on a shop listing: up to 3 option groups (e.g. Size, Colour), each with up to
// 20 values that are in stock or sold out. Customers must pick one value per group before the listing
// goes into the cart; the choice travels with the cart item and the order item.
//
// Stored on ShopListing.options as [{ name, values: [{ value, inStock }] }]. Stock counts and prices
// stay per listing (a value can only be marked sold out).
import { z } from 'zod';
import { AppError } from './errors.js';

const text = z
  .string()
  .trim()
  .min(1)
  .max(30)
  // Plain words only: no control characters, and none of the characters used in the cart key
  .regex(/^[^\u0000-\u001f\u007f=|]+$/, 'Use letters, numbers and simple punctuation');

const lower = (s) => s.toLocaleLowerCase('en');

export const listingOptionsSchema = z
  .array(
    z
      .object({
        name: text,
        values: z
          .array(z.object({ value: text, inStock: z.boolean().default(true) }).strict())
          .min(1)
          .max(20)
          .refine((values) => new Set(values.map((v) => lower(v.value))).size === values.length, {
            message: 'Each value can appear only once in a group',
          }),
      })
      .strict(),
  )
  .max(3)
  .refine((groups) => new Set(groups.map((g) => lower(g.name))).size === groups.length, {
    message: 'Each option name can appear only once',
  });

// What a customer sends: { "Size": "M", "Colour": "Black" }
export const chosenOptionsSchema = z.record(z.string().max(30), z.string().max(30)).refine((o) => Object.keys(o).length <= 3, {
  message: 'Too many options',
});

/** The listing's option groups as stored (null / not an array = none). */
export function groupsOf(listing) {
  return Array.isArray(listing?.options) ? listing.options : [];
}

/** Stable text key of a choice in the listing's group order, e.g. "Size=M|Colour=Black" ("" = no options). */
export function optionsKey(groups, chosen) {
  return groups.map((g) => `${g.name}=${chosen[g.name]}`).join('|');
}

/**
 * Checks a customer's choice against the listing: one in-stock value for every group, nothing else.
 * Returns { options, key } with the listing's own spelling and order.
 * Throws 422 with details.code OPTIONS_REQUIRED / OPTION_INVALID / OPTION_OUT_OF_STOCK.
 */
export function resolveChoice(listing, chosen = {}) {
  const groups = groupsOf(listing);
  const given = chosen ?? {};
  const options = {};
  const used = new Set();

  for (const group of groups) {
    const key = Object.keys(given).find((k) => lower(k.trim()) === lower(group.name));
    const raw = key === undefined ? '' : String(given[key]).trim();
    if (!raw) throw new AppError(422, 'Choose an option for every group', { code: 'OPTIONS_REQUIRED', group: group.name });
    const value = group.values.find((v) => lower(v.value) === lower(raw));
    if (!value) throw new AppError(422, 'This option does not exist', { code: 'OPTION_INVALID', group: group.name });
    if (value.inStock === false) throw new AppError(422, 'This option is sold out', { code: 'OPTION_OUT_OF_STOCK', group: group.name });
    options[group.name] = value.value;
    used.add(key);
  }
  if (Object.keys(given).some((k) => !used.has(k))) throw new AppError(422, 'This option does not exist', { code: 'OPTION_INVALID' });

  return { options, key: optionsKey(groups, options) };
}

/** Is an earlier choice (e.g. in a cart) still possible: every group answered with an in-stock value? */
export function choiceStillValid(listing, options) {
  try {
    const { key } = resolveChoice(listing, options ?? {});
    return key === optionsKey(groupsOf(listing), options ?? {});
  } catch {
    return false;
  }
}

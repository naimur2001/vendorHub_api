// Shop analytics events. Best effort: never throws and never slows the request that caused it.
// Privacy: a view stores only an HMAC of (Dhaka day + visitor) with a server secret. The visitor is
// the user id when logged in, else IP + user agent; none of these are stored, and the daily key
// means the same visitor cannot be followed from one day to the next.
import crypto from 'node:crypto';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { env } from '../config/env.js';

const DHAKA_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' });

/** "YYYY-MM-DD" of a moment in Asia/Dhaka. */
export const dhakaDay = (date = new Date()) => DHAKA_DAY.format(date);
/** A Dhaka day as the value of a DATE column. */
export const dayValue = (yyyyMmDd) => new Date(`${yyyyMmDd}T00:00:00Z`);

function visitorHash(req, day) {
  const who = req.user?.id ? `u:${req.user.id}` : `a:${req.ip}|${req.get('user-agent') ?? ''}`;
  return crypto.createHmac('sha256', env.JWT_ACCESS_SECRET).update(`listing-view|${day}|${who}`).digest('hex');
}

/** One view of a listing's product page (counted once per visitor per day). */
export function recordView(req, listing) {
  if (!listing) return;
  const day = dhakaDay();
  prisma.listingView
    .createMany({
      data: [{ listingId: listing.id, shopId: listing.shopId, day: dayValue(day), visitorHash: visitorHash(req, day) }],
      skipDuplicates: true, // the same visitor again today: not counted twice
    })
    .catch((err) => logger.warn({ err: err.message }, 'could not record a listing view'));
}

/** One add-to-cart of a listing. */
export function recordAddToCart(listing) {
  if (!listing) return;
  prisma.addToCartEvent
    .create({ data: { listingId: listing.id, shopId: listing.shopId, day: dayValue(dhakaDay()) } })
    .catch((err) => logger.warn({ err: err.message }, 'could not record an add-to-cart'));
}

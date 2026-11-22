// Shop opening hours. Days: 0 = Sunday ... 6 = Saturday (like JavaScript's getDay).
// Times are "HH:mm" in Asia/Dhaka local time; a closing time of "24:00" means midnight at the end
// of the day. A closing time BEFORE the opening time means the shop closes after midnight, on the
// next day (e.g. 10:00-01:00). Such an overnight shift belongs to the day it starts on: on the
// weekly holiday the shop does not open, but the end of the previous night's shift still counts.
import { z } from 'zod';

export const TIME_ZONE = 'Asia/Dhaka';
const OPEN_TIME = /^([01]\d|2[0-3]):[0-5]\d$/; // 00:00 - 23:59
const CLOSE_TIME = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/; // 00:00 - 24:00

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export const weekday = z.number().int().min(0).max(6);

const dayEntry = z
  .object({
    day: weekday,
    open: z.string().regex(OPEN_TIME, 'Use HH:mm (00:00 - 23:59)').nullable().optional(),
    close: z.string().regex(CLOSE_TIME, 'Use HH:mm (00:00 - 24:00)').nullable().optional(),
    closed: z.boolean(),
  })
  .superRefine((d, ctx) => {
    if (d.closed) return;
    if (!d.open || !d.close) {
      ctx.addIssue({ code: 'custom', message: 'An open day needs open and close times', path: ['open'] });
    } else if (d.close === d.open) {
      // equal times would be a 0- or 24-hour day; a whole day is "00:00"-"24:00"
      ctx.addIssue({ code: 'custom', message: 'close must differ from open', path: ['close'] });
    }
  })
  // stored in one shape: a closed day has no times
  .transform((d) => (d.closed ? { day: d.day, open: null, close: null, closed: true } : { day: d.day, open: d.open, close: d.close, closed: false }));

export const hoursSchema = z
  .array(dayEntry)
  .length(7, 'Send exactly 7 days')
  .refine((days) => new Set(days.map((d) => d.day)).size === 7, { message: 'Each day 0-6 must appear exactly once' })
  .transform((days) => [...days].sort((a, b) => a.day - b.day));

// The weekday and minute of the day in Dhaka for a moment in time.
const dhakaParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function dhakaNow(date = new Date()) {
  const parts = Object.fromEntries(dhakaParts.formatToParts(date).map((p) => [p.type, p.value]));
  return { day: DAY_INDEX[parts.weekday], minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** The holiday that applies: the shop's own, else its market's, else none. */
export const effectiveHoliday = (shop) => shop.weeklyHoliday ?? shop.market?.weeklyHoliday ?? null;

/**
 * true / false, or null when the shop has not set its hours.
 * @param {Array|null} hours  the stored 7 entries
 * @param {number|null} holiday  the effective weekly holiday
 */
export function openNow(hours, holiday, date = new Date()) {
  if (!Array.isArray(hours) || hours.length !== 7) return null;
  const { day, minutes } = dhakaNow(date);
  const entry = (d) => {
    const h = hours.find((x) => x.day === d);
    return h && !h.closed && d !== holiday ? { open: toMinutes(h.open), close: toMinutes(h.close) } : null;
  };
  const overnight = (h) => h.close <= h.open; // closes on the next day ("24:00" is 1440, never overnight)

  // today's shift (until midnight when it runs overnight)
  const today = entry(day);
  if (today && minutes >= today.open && (overnight(today) || minutes < today.close)) return true;
  // the end of yesterday's overnight shift, after midnight
  const yesterday = entry((day + 6) % 7);
  return Boolean(yesterday && overnight(yesterday) && minutes < yesterday.close);
}

/** The public hours fields of a shop (needs shop.hours, shop.weeklyHoliday and shop.market?.weeklyHoliday). */
export function presentHours(shop, date = new Date()) {
  const holiday = effectiveHoliday(shop);
  const hours = Array.isArray(shop.hours) ? shop.hours : null;
  return { hours, weeklyHoliday: holiday, openNow: openNow(hours, holiday, date) };
}

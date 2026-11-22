// DEVELOPMENT TOOL for test-shop-hours.ps1: checks openNow / hoursSchema at fixed moments.
// Prints one JSON line per case: {"name","got","expected"}. Asia/Dhaka is UTC+6 (no daylight saving).
import { openNow, effectiveHoliday, hoursSchema } from '../src/lib/openingHours.js';

const day = (d, open, close) => ({ day: d, open, close, closed: false });
// Sun-Thu & Sat 10:00-20:00, Tuesday closed, Friday the whole day (00:00-24:00)
const hours = [
  day(0, '10:00', '20:00'),
  day(1, '10:00', '20:00'),
  { day: 2, open: null, close: null, closed: true },
  day(3, '10:00', '20:00'),
  day(4, '10:00', '20:00'),
  day(5, '00:00', '24:00'),
  day(6, '10:00', '20:00'),
];
const at = (iso) => new Date(iso);
const out = [];
const check = (name, got, expected) => out.push({ name, got, expected });

// Sunday 2026-11-22 in Dhaka
check('Sun 09:59 before opening', openNow(hours, null, at('2026-11-22T03:59:00Z')), false);
check('Sun 10:00 opening minute', openNow(hours, null, at('2026-11-22T04:00:00Z')), true);
check('Sun 19:59 last minute', openNow(hours, null, at('2026-11-22T13:59:00Z')), true);
check('Sun 20:00 closing minute', openNow(hours, null, at('2026-11-22T14:00:00Z')), false);
// Thursday 23:59 Dhaka -> closed; one minute later it is Friday 00:00 in Dhaka (still Thursday in UTC)
check('Thu 23:59 closed', openNow(hours, null, at('2026-11-26T17:59:00Z')), false);
check('Fri 00:00 Dhaka (Thu in UTC) open', openNow(hours, null, at('2026-11-26T18:00:00Z')), true);
check('Fri 23:59 open until 24:00', openNow(hours, null, at('2026-11-27T17:59:00Z')), true);
check('Sat 00:00 after a 24:00 close', openNow(hours, null, at('2026-11-27T18:00:00Z')), false);
check('Tue closed day', openNow(hours, null, at('2026-11-24T06:00:00Z')), false);
check('weekly holiday Sun at noon', openNow(hours, 0, at('2026-11-22T06:00:00Z')), false);
check('holiday Fri, Fri 00:00 Dhaka', openNow(hours, 5, at('2026-11-26T18:00:00Z')), false);
check('holiday on another day', openNow(hours, 3, at('2026-11-22T06:00:00Z')), true);
check('no hours -> null', openNow(null, null, at('2026-11-22T06:00:00Z')), null);
check('no hours + holiday -> null', openNow(null, 0, at('2026-11-22T06:00:00Z')), null);
check('own holiday wins', effectiveHoliday({ weeklyHoliday: 1, market: { weeklyHoliday: 3 } }), 1);
check('market holiday used', effectiveHoliday({ weeklyHoliday: null, market: { weeklyHoliday: 3 } }), 3);
check('no market', effectiveHoliday({ weeklyHoliday: null, market: null }), null);

// overnight: Saturday 10:00-01:00 (closes Sunday 01:00), the rest of the week 10:00-20:00
const late = hours.map((h) => (h.day === 6 ? day(6, '10:00', '01:00') : h));
check('overnight: Sat 23:30 open', openNow(late, null, at('2026-11-28T17:30:00Z')), true);
check('overnight: Sun 00:00 still open', openNow(late, null, at('2026-11-28T18:00:00Z')), true);
check('overnight: Sun 00:59 still open', openNow(late, null, at('2026-11-28T18:59:00Z')), true);
check('overnight: Sun 01:00 closed', openNow(late, null, at('2026-11-28T19:00:00Z')), false);
check('overnight: Sat 09:59 closed', openNow(late, null, at('2026-11-28T03:59:00Z')), false);
check('overnight: Fri night not affected', openNow(late, null, at('2026-11-27T18:30:00Z')), false);
check('overnight: Sun holiday, Sat shift still ends 01:00', openNow(late, 0, at('2026-11-28T18:30:00Z')), true);
check('overnight: Sat holiday, no spill into Sun', openNow(late, 6, at('2026-11-28T18:30:00Z')), false);
const toMidnight = hours.map((h) => (h.day === 0 ? day(0, '18:00', '00:00') : h));
check('close 00:00 = until midnight: Sun 23:59 open', openNow(toMidnight, null, at('2026-11-22T17:59:00Z')), true);
check('close 00:00: Mon 00:00 closed', openNow(toMidnight, null, at('2026-11-22T18:00:00Z')), false);

// validation
const ok = (h) => hoursSchema.safeParse(h).success;
check('valid week accepted', ok(hours), true);
check('6 days rejected', ok(hours.slice(0, 6)), false);
check('duplicate day rejected', ok([...hours.slice(0, 6), day(0, '10:00', '20:00')]), false);
check('overnight (close before open) accepted', ok(hours.map((h) => (h.day === 0 ? day(0, '10:00', '01:00') : h))), true);
check('close equal to open rejected', ok(hours.map((h) => (h.day === 0 ? day(0, '10:00', '10:00') : h))), false);
check('25:00 rejected', ok(hours.map((h) => (h.day === 0 ? day(0, '10:00', '25:00') : h))), false);
check('9:00 (no leading zero) rejected', ok(hours.map((h) => (h.day === 0 ? day(0, '9:00', '20:00') : h))), false);
check('open 24:00 rejected', ok(hours.map((h) => (h.day === 0 ? day(0, '24:00', '24:00') : h))), false);
check('open day without times rejected', ok(hours.map((h) => (h.day === 0 ? { day: 0, closed: false } : h))), false);
check('day 7 rejected', ok(hours.map((h) => (h.day === 6 ? day(7, '10:00', '20:00') : h))), false);

for (const row of out) console.log(JSON.stringify(row));

// DEVELOPMENT TOOL: runs one reservation sweep, optionally at a pretend time (a fake clock for the tests).
// Usage: node --env-file=.env scripts/run-reservation-sweep.mjs [--minutes-ahead=N]
// Prints {"notConfirmed":n,"expired":n}.
import { sweepReservations } from '../src/jobs/reservations.js';
import { prisma } from '../src/lib/prisma.js';

const arg = process.argv.find((a) => a.startsWith('--minutes-ahead='));
const minutes = arg ? Number(arg.split('=')[1]) : 0;
if (!Number.isFinite(minutes)) throw new Error('--minutes-ahead must be a number');
try {
  const result = await sweepReservations(new Date(Date.now() + minutes * 60 * 1000));
  console.log(JSON.stringify(result));
} finally {
  await prisma.$disconnect();
}

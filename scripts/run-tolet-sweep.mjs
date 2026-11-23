// Usage: node --env-file=.env scripts/run-tolet-sweep.mjs [--days-ahead=N]
// Runs the Shop To-Let job once, as if it were N days from now (tests: reminders and expiry).
import { sweepToLet } from '../src/modules/toLet/toLet.job.js';
import { prisma } from '../src/lib/prisma.js';

const arg = process.argv.find((a) => a.startsWith('--days-ahead='));
const days = arg ? Number(arg.split('=')[1]) : 0;
const result = await sweepToLet(new Date(Date.now() + days * 24 * 60 * 60 * 1000));
await prisma.$disconnect();
console.log(JSON.stringify(result));

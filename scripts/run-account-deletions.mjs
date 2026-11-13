// Runs the account deletion jobs once (the server also runs them every hour).
// Usage: node --env-file=.env scripts/run-account-deletions.mjs
import { prisma } from '../src/lib/prisma.js';
import { runAccountDeletionJobs } from '../src/modules/users/accountDeletion.job.js';

const result = await runAccountDeletionJobs();
console.log(`Reminders sent: ${result.reminders}; accounts due: ${result.due}; anonymised: ${result.anonymised}`);
await prisma.$disconnect();
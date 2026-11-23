import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { expireStaleBargains } from './modules/bargains/bargains.service.js';
import { runAccountDeletionJobs } from './modules/users/accountDeletion.job.js';
import { runReservationSweep } from './jobs/reservations.js';
import { runToLetSweep } from './modules/toLet/toLet.job.js';
const server = app.listen(env.PORT, () => {
  logger.info(`API running on http://localhost:${env.PORT}`);
});

// Close bargains whose time ran out. They are also closed on read, so users never see stale states.
const sweeper = setInterval(() => {
  expireStaleBargains().catch((err) => logger.error(err, 'expireStaleBargains failed'));
}, 60 * 1000);
sweeper.unref();

// Reserve for pickup: cancel reservations the shop did not confirm in time, or that ran out.
const reservationJob = setInterval(runReservationSweep, 60 * 1000);
reservationJob.unref();


// Account deletion: reminders and anonymisation, hourly (cheap: it only looks at accounts that are due).
const runDeletions = () =>
  runAccountDeletionJobs()
    .then((r) => (r.reminders || r.anonymised) && logger.info(r, 'account deletion jobs'))
    .catch((err) => logger.error(err, 'account deletion jobs failed'));
// Shop To-Let: expiry reminders and expiry (daily is enough; every 6 hours keeps it close to the date).
const toLetJob = setInterval(runToLetSweep, 6 * 60 * 60 * 1000);
toLetJob.unref();
setTimeout(runToLetSweep, 90 * 1000).unref();

const deletionJob = setInterval(runDeletions, 60 * 60 * 1000);
deletionJob.unref();
setTimeout(runDeletions, 60 * 1000).unref(); // also shortly after start

// Graceful shutdown (Docker / systemd send SIGTERM): stop taking requests, then close the database.
function shutdown(signal) {
  logger.info(`${signal} received, shutting down`);
  clearInterval(sweeper);
  clearInterval(reservationJob);
  clearInterval(deletionJob);
  clearInterval(toLetJob);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10 * 1000).unref(); // do not hang forever
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error(reason, 'Unhandled promise rejection'));
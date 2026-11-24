// Product deletion requests: every 10 minutes from server.js (and by
// scripts/product-deletion-test-helper.mjs with a fake clock in the tests).
// Safe to run twice: each request is claimed with a guarded update inside its transaction.
import { logger } from '../../lib/logger.js';
import { sweepDeletionRequests } from './productDeletion.service.js';

let running = false; // never two sweeps at the same time in one process
export async function runProductDeletionSweep() {
  if (running) return;
  running = true;
  try {
    const r = await sweepDeletionRequests();
    if (r.deleted || r.listingsDeleted || r.deactivated || r.failed) logger.info(r, 'product deletion requests carried out');
  } catch (err) {
    logger.error(err, 'product deletion sweep failed');
  } finally {
    running = false;
  }
}

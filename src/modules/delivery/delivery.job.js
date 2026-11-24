// Courier jobs, from server.js: booking retries every minute, tracking poll every SHIPMENT_POLL_MINUTES.
// Both are safe to run twice (bookings are claimed, events are de-duplicated).
import { logger } from '../../lib/logger.js';
import { retryBookings, pollShipments } from './shipments.service.js';

const once = (name, work) => {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      const r = await work();
      if (Object.values(r).some((n) => n > 0)) logger.info(r, name);
    } catch (err) {
      logger.error(err, `${name} failed`);
    } finally {
      running = false;
    }
  };
};

export const runBookingRetries = once('courier booking retries', () => retryBookings());
export const runShipmentPoll = once('shipment poll', () => pollShipments());

// Shipment views for customers and shops (a leaf module: checkout and fulfilment import it at load time).
import { AFTER_PICKUP } from '../../lib/couriers/statusMap.js';
import { COURIER_MAX_BOOKING_TRIES } from '../../config/limits.js';

export const shipmentInclude = {
  provider: { select: { id: true, code: true, name: true } },
  events: { orderBy: { at: 'asc' } },
};

const timeline = (s) => s.events.filter((e) => e.status).map((e) => ({ status: e.status, at: e.at }));

/** Customer: status and timeline; the courier name and tracking code only from PICKED_UP on. */
export function forCustomer(s) {
  if (!s) return null;
  const shown = AFTER_PICKUP.has(s.status);
  return {
    status: s.status,
    timeline: timeline(s),
    courier: shown && s.provider ? { name: s.provider.name } : null,
    trackingCode: shown ? s.trackingCode : null,
  };
}

/** Shop team: no courier cost and no margin. */
export function forShop(s) {
  if (!s) return null;
  return {
    id: s.id,
    status: s.status,
    timeline: timeline(s),
    courier: s.provider ? { name: s.provider.name } : null,
    trackingCode: s.trackingCode,
    codAmount: s.codAmount,
    shopPaid: Boolean(s.shopPaidAt),
    shopPaidAt: s.shopPaidAt,
    bookingFailed: s.status === 'PENDING' && s.bookingAttempts >= COURIER_MAX_BOOKING_TRIES && !s.nextAttemptAt,
  };
}


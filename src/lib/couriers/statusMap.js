// Courier status names -> our ShipmentStatus. null = a known event that does not change our status
// (on hold, paid, ...): it is kept on the timeline only. Unknown names are also kept, with null.
//
// Pathao: webhook event names ("order.picked") and the order_status_slug of the order info call
// ("Picked"). TO CONFIRM against Pathao's merchant docs: the names below come from the Pathao
// merchant panel's webhook list; the official docs page could not be read when this was written.
const PATHAO = {
  'order.created': 'BOOKED',
  'order.updated': null,
  'order.pickup-requested': 'BOOKED',
  'order.assigned-for-pickup': 'PICKUP_ASSIGNED',
  'order.picked': 'PICKED_UP',
  'order.pickup-failed': 'FAILED',
  'order.pickup-cancelled': 'CANCELLED',
  'order.at-the-sorting-hub': 'IN_TRANSIT',
  'order.in-transit': 'IN_TRANSIT',
  'order.received-at-last-mile-hub': 'IN_TRANSIT',
  'order.assigned-for-delivery': 'OUT_FOR_DELIVERY',
  'order.delivered': 'DELIVERED',
  'order.partial-delivery': 'DELIVERED',
  'order.delivery-failed': 'FAILED',
  'order.on-hold': null,
  'order.return': 'RETURNING',
  'order.returned': 'RETURNED',
  'order.paid-return': 'RETURNED',
  'order.paid': null, // Pathao paid the collected cash out to us (codRemittedAt)
  'order.exchanged': null,
  // order_status_slug values (polling)
  pending: 'BOOKED',
  pickup_requested: 'BOOKED',
  assigned_for_pickup: 'PICKUP_ASSIGNED',
  picked: 'PICKED_UP',
  pickup_failed: 'FAILED',
  pickup_cancelled: 'CANCELLED',
  at_the_sorting_hub: 'IN_TRANSIT',
  in_transit: 'IN_TRANSIT',
  received_at_last_mile_hub: 'IN_TRANSIT',
  assigned_for_delivery: 'OUT_FOR_DELIVERY',
  delivered: 'DELIVERED',
  partial_delivery: 'DELIVERED',
  delivery_failed: 'FAILED',
  on_hold: null,
  return: 'RETURNING',
  returned: 'RETURNED',
  paid_return: 'RETURNED',
  paid: null,
};

const MAPS = { PATHAO };

/** Our status for a courier status name (case and separators do not matter for slugs). */
export function mapCourierStatus(code, raw) {
  const map = MAPS[code] ?? {};
  if (!raw) return null;
  if (raw in map) return map[raw];
  const slug = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return slug in map ? map[slug] : null;
}

export const PAID_OUT_EVENTS = new Set(['order.paid', 'paid']);

// Our statuses in their normal order; a terminal one never changes again.
export const STATUS_ORDER = [
  'PENDING',
  'BOOKED',
  'PICKUP_ASSIGNED',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'FAILED',
  'RETURNING',
  'DELIVERED',
  'RETURNED',
  'CANCELLED',
];
export const TERMINAL = new Set(['DELIVERED', 'RETURNED', 'CANCELLED']);
export const ACTIVE = ['BOOKED', 'PICKUP_ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'FAILED', 'RETURNING'];
// from PICKED_UP on, the customer may see the courier name and the tracking code
export const AFTER_PICKUP = new Set(['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'RETURNING', 'RETURNED']);

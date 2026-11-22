// Reserve-for-pickup deadlines, run every minute from server.js (and by scripts/run-reservation-sweep.mjs
// with a fake clock in the tests).
//   1. PLACED and not confirmed RESERVATION_CONFIRM_MINUTES after ordering -> cancelled "Shop did not confirm"
//   2. not COMPLETED by reservedUntil                                      -> cancelled "Reservation expired"
// Each cancel puts the stock back, writes a SYSTEM status event and an audit entry, then notifies
// the customer and the shop team. Safe to run twice (or in two processes): every order is claimed
// with a guarded update on its current status, so only one run can cancel it.
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { notify } from '../lib/notify.js';
import { RESERVATION_CONFIRM_MINUTES } from '../config/limits.js';
import { restock } from '../modules/fulfilment/fulfilment.service.js';
import { releasePromotions } from '../modules/promotions/promotions.service.js';
import { shopTeamIds } from '../modules/notifications/notifications.events.js';

export const REASON_NOT_CONFIRMED = 'Shop did not confirm';
export const REASON_EXPIRED = 'Reservation expired';
const BATCH = 200;

const select = { id: true, status: true, orderNumber: true, shopId: true, checkout: { select: { userId: true } } };

async function autoCancel(order, reason) {
  const cancelled = await prisma.$transaction(async (tx) => {
    const claimed = await tx.subOrder.updateMany({
      where: { id: order.id, status: order.status },
      data: { status: 'CANCELLED' },
    });
    if (claimed.count !== 1) return false; // already changed by the shop or by another run
    await restock(tx, order.id);
    await releasePromotions(tx, order.id);
    await tx.orderStatusEvent.create({
      data: { subOrderId: order.id, status: 'CANCELLED', actorRole: 'SYSTEM', note: reason },
    });
    await tx.auditLog.create({
      data: {
        actorId: null,
        action: 'order.auto_cancelled',
        entityType: 'SubOrder',
        entityId: order.id,
        meta: { from: order.status, to: 'CANCELLED', reason },
      },
    });
    return true;
  });
  if (!cancelled) return false;

  // after the commit; notify() never throws
  await notify([order.checkout.userId], {
    type: 'ORDER_STATUS',
    title: `Reservation ${order.orderNumber} was cancelled`,
    body: `${reason}. The item is no longer held for you.`,
    data: { orderId: order.id, status: 'CANCELLED' },
  });
  await notify(await shopTeamIds(order.shopId), {
    type: 'ORDER_CANCELLED',
    title: `Reservation ${order.orderNumber} was cancelled automatically`,
    body: `${reason}. The stock is available again.`,
    data: { orderId: order.id, shopId: order.shopId },
  });
  return true;
}

/** One sweep at the moment `now` (a parameter so tests can move the clock). */
export async function sweepReservations(now = new Date()) {
  const confirmCutoff = new Date(now.getTime() - RESERVATION_CONFIRM_MINUTES * 60 * 1000);
  const unconfirmed = await prisma.subOrder.findMany({
    where: { deliveryMethod: 'RESERVE_PICKUP', status: 'PLACED', createdAt: { lte: confirmCutoff } },
    select,
    take: BATCH,
  });
  const expired = await prisma.subOrder.findMany({
    where: {
      deliveryMethod: 'RESERVE_PICKUP',
      status: { in: ['PLACED', 'CONFIRMED', 'READY_FOR_PICKUP'] },
      reservedUntil: { lte: now },
      id: { notIn: unconfirmed.map((o) => o.id) },
    },
    select,
    take: BATCH,
  });

  const result = { notConfirmed: 0, expired: 0 };
  for (const o of unconfirmed) if (await autoCancel(o, REASON_NOT_CONFIRMED)) result.notConfirmed++;
  for (const o of expired) if (await autoCancel(o, REASON_EXPIRED)) result.expired++;
  return result;
}

// In one process, never two sweeps at the same time (a slow sweep must not overlap the next tick).
let running = false;
export async function runReservationSweep() {
  if (running) return;
  running = true;
  try {
    const r = await sweepReservations();
    if (r.notConfirmed || r.expired) logger.info(r, 'reservations cancelled automatically');
  } catch (err) {
    logger.error(err, 'reservation sweep failed');
  } finally {
    running = false;
  }
}

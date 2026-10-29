import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { notify } from '../../lib/notify.js';

const STATUS_TEXT = {
  CONFIRMED: 'was confirmed by the shop',
  READY_FOR_PICKUP: 'is ready for pickup',
  OUT_FOR_DELIVERY: 'is out for delivery',
  COMPLETED: 'is completed',
  CANCELLED: 'was cancelled by the shop',
};

// The owner and every staff member of a shop.
export async function shopTeamIds(shopId) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { ownerId: true, staff: { select: { userId: true } } },
  });
  return shop ? [shop.ownerId, ...shop.staff.map((s) => s.userId)] : [];
}

// Every active admin.
async function adminIds() {
  const admins = await prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } });
  return admins.map((a) => a.id);
}

// ---------- orders ----------

// After a checkout: every shop hears about ITS OWN order only; the customer gets one note per order.
export async function notifyNewOrders(customerId, checkoutId) {
  try {
    const orders = await prisma.subOrder.findMany({
      where: { checkoutId },
      include: { items: { select: { quantity: true } }, shop: { select: { id: true, name: true } } },
    });
    for (const o of orders) {
      const units = o.items.reduce((n, i) => n + i.quantity, 0);
      const how = o.deliveryMethod === 'STORE_PICKUP' ? 'store pickup' : 'delivery';
      await notify(await shopTeamIds(o.shopId), {
        type: 'ORDER_NEW',
        title: `New order ${o.orderNumber}`,
        body: `${units} item(s), ${o.total} taka, ${how}`,
        data: { orderId: o.id, shopId: o.shopId },
      });
      await notify([customerId], {
        type: 'ORDER_PLACED',
        title: `Order ${o.orderNumber} placed`,
        body: `${o.shop.name} has received your order.`,
        data: { orderId: o.id, checkoutId },
      });
    }
  } catch (err) {
    logger.error(err, 'could not send new-order notifications');
  }
}

// After the shop moves an order: tell the customer.
export async function notifyStatusChange(order, status, reason) {
  try {
    const session = await prisma.checkoutSession.findUnique({
      where: { id: order.checkoutId },
      select: { userId: true },
    });
    await notify([session?.userId], {
      type: 'ORDER_STATUS',
      title: `Order ${order.orderNumber} ${STATUS_TEXT[status]}`,
      body: reason ? `Reason: ${reason}` : 'Open the order for details.',
      data: { orderId: order.id, status },
    });
  } catch (err) {
    logger.error(err, 'could not send the order status notification');
  }
}

// After the customer cancels: tell that shop's team.
export async function notifyCustomerCancel(order, reason) {
  try {
    await notify(await shopTeamIds(order.shopId), {
      type: 'ORDER_CANCELLED',
      title: `Order ${order.orderNumber} was cancelled by the customer`,
      body: reason ? `Reason: ${reason}` : 'No reason given.',
      data: { orderId: order.id, shopId: order.shopId },
    });
  } catch (err) {
    logger.error(err, 'could not send the cancellation notification');
  }
}

// ---------- returns ----------

// event: requested, approved, rejected, escalated, resolved, message. The actor is never told about their own action.
export async function notifyReturn(returnId, event, actorId) {
  try {
    const r = await prisma.returnRequest.findUnique({
      where: { id: returnId },
      select: {
        id: true,
        status: true,
        customerId: true,
        subOrderId: true,
        subOrder: { select: { orderNumber: true, shopId: true } },
      },
    });
    if (!r) return;
    const team = await shopTeamIds(r.subOrder.shopId);
    const n = r.subOrder.orderNumber;
    let to = [];
    let title = '';
    let body = 'Open the return for details.';

    if (event === 'requested') {
      to = team;
      title = `Return requested for order ${n}`;
    } else if (event === 'approved') {
      to = [r.customerId];
      title = `Your return for order ${n} was approved`;
      body = 'The refund has been recorded.';
    } else if (event === 'rejected') {
      to = [r.customerId];
      title = `Your return for order ${n} was rejected`;
      body = 'Read the shop note. You can escalate it to an admin.';
    } else if (event === 'escalated') {
      to = [...team, ...(await adminIds())];
      title = `Return for order ${n} was escalated to an admin`;
    } else if (event === 'resolved') {
      to = [r.customerId, ...team];
      title = `An admin decided the return for order ${n}`;
      body = r.status === 'REFUNDED' ? 'Decision: refund.' : 'Decision: closed without a refund.';
    } else if (event === 'message') {
      to = [r.customerId, ...team, ...(r.status === 'ESCALATED' ? await adminIds() : [])];
      title = `New message about the return for order ${n}`;
    }

    await notify(
      to.filter((id) => id !== actorId),
      { type: `RETURN_${event.toUpperCase()}`, title, body, data: { returnId: r.id, orderId: r.subOrderId } },
    );
  } catch (err) {
    logger.error(err, 'could not send the return notification');
  }
}
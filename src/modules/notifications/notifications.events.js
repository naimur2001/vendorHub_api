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
async function shopTeamIds(shopId) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { ownerId: true, staff: { select: { userId: true } } },
  });
  return shop ? [shop.ownerId, ...shop.staff.map((s) => s.userId)] : [];
}

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
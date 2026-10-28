import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { deriveAvailability } from '../../lib/availability.js';

const DELIVERY_FEE = 60; // taka, charged once per shop that delivers

const newOrderNumber = () => {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `VH-${day}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
};

const orderInclude = {
  shop: {
    select: {
      id: true,
      name: true,
      slug: true,
      logoUrl: true,
      levelFloor: true,
      shopNumber: true,
      addressLine: true,
      verificationLevel: true,
    },
  },
  items: true,
};

const formatOrder = (o) => ({
  id: o.id,
  orderNumber: o.orderNumber,
  checkoutId: o.checkoutId,
  status: o.status,
  paymentMethod: o.paymentMethod,
  paymentStatus: o.paymentStatus,
  deliveryMethod: o.deliveryMethod,
  deliveryAddress: o.deliveryAddress,
  deliveryFee: o.deliveryFee,
  subtotal: o.subtotal,
  total: o.total,
  createdAt: o.createdAt,
  shop: o.shop,
  items: o.items.map((i) => ({
    id: i.id,
    title: i.title,
    unitPrice: i.unitPrice,
    quantity: i.quantity,
    lineTotal: i.unitPrice * i.quantity,
    bargained: i.bargained,
  })),
});

export async function placeOrders(userId, { shops: choices }) {
  const choiceIds = choices.map((c) => c.shopId);
  if (new Set(choiceIds).size !== choiceIds.length) {
    throw new AppError(400, 'Each shop can appear only once');
  }

  // Everything below runs in ONE transaction: if any step fails, nothing is saved
  // (no half-created orders, no stock removed for an order that was never placed).
  return prisma.$transaction(
    async (tx) => {
      const cart = await tx.cart.findUnique({
        where: { userId },
        include: {
          items: {
            include: {
              listing: {
                include: {
                  product: { select: { title: true } },
                  shop: {
                    select: { id: true, name: true, isActive: true, supportsDelivery: true, supportsPickup: true },
                  },
                },
              },
              bargain: { select: { status: true, agreedPrice: true, customerId: true } },
            },
          },
        },
      });
      // if (!cart || cart.items.length === 0) throw new AppError(400, 'Your cart is empty');
        if (!cart || cart.items.length === 0) throw new AppError(400, 'Your cart is empty');

        // a saved address can be used instead of typing one
        for (const c of choices) {
          if (!c.addressId) continue;
          const saved = await tx.address.findFirst({ where: { id: c.addressId, userId } });
          if (!saved) throw new AppError(400, 'Delivery address not found');
          c.deliveryAddress = `${saved.line1}${saved.area ? `, ${saved.area}` : ''}, ${saved.city}. Phone: ${saved.phone}`;
        }

      // 1. Re-check every item and group by shop. Prices are re-read here, never taken from the client.
      const byShop = new Map();
      const problems = [];
      for (const item of cart.items) {
        const l = item.listing;
        let problem = null;
        if (!l.isActive || !l.shop.isActive) problem = 'UNAVAILABLE';
        else if (l.availability === 'OUT_OF_STOCK') problem = 'OUT_OF_STOCK';
        else if (l.stockQty !== null && item.quantity > l.stockQty) problem = 'INSUFFICIENT_STOCK';
        if (problem) {
          problems.push({ listingId: l.id, title: l.product.title, problem });
          continue;
        }

        const bargained = Boolean(
          item.bargain &&
            item.bargain.status === 'ACCEPTED' &&
            item.bargain.agreedPrice &&
            item.bargain.customerId === userId,
        );
        // const unitPrice = bargained ? item.bargain.agreedPrice : l.price;
           const unitPrice = bargained ? Math.min(item.bargain.agreedPrice, l.price) : l.price; 
           // never pay more than the current listing price

        if (!byShop.has(l.shop.id)) byShop.set(l.shop.id, { shop: l.shop, lines: [] });
        byShop.get(l.shop.id).lines.push({
          listingId: l.id,
          title: l.product.title,
          unitPrice,
          quantity: item.quantity,
          bargained,
          stockQty: l.stockQty,
        });
      }
      if (problems.length) {
        throw new AppError(409, 'Some items in your cart are no longer available', problems);
      }

      // 2. The request must cover exactly the shops in the cart
      const missing = [...byShop.keys()].filter((id) => !choiceIds.includes(id));
      const extra = choiceIds.filter((id) => !byShop.has(id));
      if (missing.length || extra.length) {
        throw new AppError(
          400,
          'Choose delivery and payment for every shop in your cart, and only for those shops',
          { missing, extra },
        );
      }

      // 3. Validate each shop's delivery and payment choice
      for (const c of choices) {
        const { shop } = byShop.get(c.shopId);
        if (c.deliveryMethod === 'VENDOR_DELIVERY') {
          if (!shop.supportsDelivery) throw new AppError(400, `${shop.name} does not offer delivery`);
          if (!c.deliveryAddress) throw new AppError(400, `A delivery address is required for ${shop.name}`);
        }
        if (c.deliveryMethod === 'STORE_PICKUP' && !shop.supportsPickup) {
          throw new AppError(400, `${shop.name} does not offer store pickup`);
        }
        if (c.paymentMethod === 'PAY_AT_STORE' && c.deliveryMethod !== 'STORE_PICKUP') {
          throw new AppError(400, 'Pay at store is only available with store pickup');
        }
        if (c.paymentMethod === 'CASH_ON_DELIVERY' && c.deliveryMethod !== 'VENDOR_DELIVERY') {
          throw new AppError(400, 'Cash on delivery is only available with vendor delivery');
        }
      }

      // 4. Take the stock. The condition stockQty >= quantity makes this safe when two
      //    customers buy the last unit at the same time: one of them gets 409.
      for (const { lines } of byShop.values()) {
        for (const line of lines) {
          if (line.stockQty === null) continue; // the shop does not track a number for this listing
          const taken = await tx.shopListing.updateMany({
            where: { id: line.listingId, stockQty: { gte: line.quantity } },
            data: { stockQty: { decrement: line.quantity } },
          });
          if (taken.count !== 1) throw new AppError(409, `Not enough stock for ${line.title}`);

          const left = await tx.shopListing.findUnique({
            where: { id: line.listingId },
            select: { stockQty: true },
          });
          await tx.shopListing.update({
            where: { id: line.listingId },
            data: { availability: deriveAvailability(left.stockQty) },
          });
        }
      }

      // 5. One parent session, one independent order per shop
      const session = await tx.checkoutSession.create({ data: { userId, totalAmount: 0 } });
      let totalAmount = 0;
      const orders = [];
      for (const c of choices) {
        const { lines } = byShop.get(c.shopId);
        const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
        const deliveryFee = c.deliveryMethod === 'VENDOR_DELIVERY' ? DELIVERY_FEE : 0;
        const total = subtotal + deliveryFee;
        totalAmount += total;

        const order = await tx.subOrder.create({
          data: {
            orderNumber: newOrderNumber(),
            checkoutId: session.id,
            shopId: c.shopId,
            deliveryMethod: c.deliveryMethod,
            deliveryAddress: c.deliveryMethod === 'VENDOR_DELIVERY' ? c.deliveryAddress : null,
            deliveryFee,
            subtotal,
            total,
            paymentMethod: c.paymentMethod,
            paymentStatus: 'PENDING',
            items: {
              create: lines.map(({ listingId, title, unitPrice, quantity, bargained }) => ({
                listingId,
                title,
                unitPrice,
                quantity,
                bargained,
              })),
            },
            // online orders get a payment record that the (mock) gateway completes
            ...(c.paymentMethod === 'ONLINE' && {
              payments: { create: [{ provider: 'mock', amount: total, status: 'PENDING' }] },
            }),
          },
          include: orderInclude,
        });
        orders.push(order);
      }
      await tx.checkoutSession.update({ where: { id: session.id }, data: { totalAmount } });

         // a bargained price can be used only once
         const usedBargainIds = cart.items.filter((i) => i.bargainId).map((i) => i.bargainId);
         if (usedBargainIds.length > 0) {
           await tx.bargain.updateMany({
             where: { id: { in: usedBargainIds }, status: 'ACCEPTED' },
             data: { status: 'EXPIRED' },
           });
         }

         // 6. Empty the cart
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      return { checkoutId: session.id, totalAmount, orders: orders.map(formatOrder) };
    },
    { maxWait: 5000, timeout: 20000 },
  );
}

export async function getCheckout(userId, checkoutId) {
  const session = await prisma.checkoutSession.findFirst({
    where: { id: checkoutId, userId },
    include: { subOrders: { include: orderInclude, orderBy: { createdAt: 'asc' } } },
  });
  if (!session) throw new AppError(404, 'Checkout not found');
  return {
    checkoutId: session.id,
    totalAmount: session.totalAmount,
    createdAt: session.createdAt,
    orders: session.subOrders.map(formatOrder),
  };
}

export async function listOrders(userId, { status, page, limit }) {
  const where = { checkout: { userId }, ...(status && { status }) };
  const [total, rows] = await Promise.all([
    prisma.subOrder.count({ where }),
    prisma.subOrder.findMany({
      where,
      include: orderInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  return {
    items: rows.map(formatOrder),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

// 404 (not 403) for someone else's order, so order ids cannot be probed
async function findOwnOrder(userId, orderId) {
  const order = await prisma.subOrder.findFirst({
    where: { id: orderId, checkout: { userId } },
    include: orderInclude,
  });
  if (!order) throw new AppError(404, 'Order not found');
  return order;
}

export async function getOrder(userId, orderId) {
  return formatOrder(await findOwnOrder(userId, orderId));
}

// Stands in for the payment gateway until a real one is connected (MOCK_PAYMENTS=false turns it off).
export async function payMock(userId, orderId) {
  if (!env.MOCK_PAYMENTS) throw new AppError(404, 'Not found');

  const order = await findOwnOrder(userId, orderId);
  if (order.paymentMethod !== 'ONLINE') throw new AppError(400, 'This order is not paid online');
  if (order.status === 'CANCELLED') throw new AppError(409, 'This order was cancelled');
  if (order.paymentStatus === 'PAID') throw new AppError(409, 'This order is already paid');

  await prisma.$transaction([
    prisma.payment.updateMany({
      where: { subOrderId: orderId, status: 'PENDING' },
      data: {
        status: 'PAID',
        providerRef: `MOCK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
        rawPayload: { mock: true },
      },
    }),
    prisma.subOrder.update({ where: { id: orderId }, data: { paymentStatus: 'PAID' } }),
  ]);
  return getOrder(userId, orderId);
}
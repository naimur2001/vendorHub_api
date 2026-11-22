// ONLINE payments through the provider adapter (src/lib/payments.js).
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { paymentAdapter, paymentMode } from '../../lib/payments.js';

// Starts (or resumes) the payment of one of my ONLINE orders. Idempotent: a PENDING payment that
// already has a provider reference is returned again.
export async function createPayment(userId, orderId) {
  const order = await prisma.subOrder.findFirst({ where: { id: orderId, checkout: { userId } } });
  if (!order) throw new AppError(404, 'Order not found');
  if (order.paymentMethod !== 'ONLINE') throw new AppError(400, 'This order is not paid online');
  if (order.status === 'CANCELLED') throw new AppError(409, 'This order was cancelled');
  if (order.paymentStatus === 'PAID') throw new AppError(409, 'This order is already paid');

  const mode = paymentMode();
  let payment = await prisma.payment.findFirst({ where: { subOrderId: orderId, status: 'PENDING' }, orderBy: { createdAt: 'desc' } });
  // a FAILED attempt: a new attempt starts
  if (!payment) payment = await prisma.payment.create({ data: { subOrderId: orderId, provider: mode, amount: order.total, status: 'PENDING' } });
  if (payment.providerRef && payment.provider === mode) {
    return { paymentId: payment.id, provider: mode, amount: payment.amount, providerRef: payment.providerRef, redirectUrl: payment.rawPayload?.redirectUrl ?? null };
  }
  const started = await paymentAdapter(mode).createPayment(payment, order);
  await prisma.payment.update({
    where: { id: payment.id },
    data: { provider: mode, providerRef: started.providerRef, rawPayload: { redirectUrl: started.redirectUrl } },
  });
  return { paymentId: payment.id, provider: mode, amount: payment.amount, providerRef: started.providerRef, redirectUrl: started.redirectUrl };
}

const callbackBody = z.object({
  paymentId: z.uuid(),
  providerRef: z.string().min(1).max(100),
  status: z.enum(['PAID', 'FAILED']),
  amount: z.number().int().min(0),
});

// The gateway's callback. Signature checked first (401). Idempotent: a repeated callback for a
// payment that is no longer PENDING changes nothing and answers with the current status.
export async function handleCallback(provider, headers, rawBody) {
  if (provider !== paymentMode()) throw new AppError(404, 'Not found'); // only the active provider
  const parsed = callbackBody.safeParse(rawBody);
  if (!parsed.success) throw new AppError(400, 'Invalid callback');
  const verified = paymentAdapter(provider).verifyCallback(headers, parsed.data);
  if (!verified) {
    logger.warn({ provider }, 'payment callback with a bad signature'); // no body in the log
    throw new AppError(401, 'Invalid signature');
  }
  const payment = await prisma.payment.findUnique({ where: { id: verified.paymentId } });
  if (!payment || payment.providerRef !== verified.providerRef) throw new AppError(404, 'Payment not found');
  if (verified.amount !== payment.amount) throw new AppError(400, 'The amount does not match');

  const changed = await prisma.$transaction(async (tx) => {
    const { count } = await tx.payment.updateMany({
      where: { id: payment.id, status: 'PENDING' },
      data: { status: verified.status, callbackAt: new Date(), rawPayload: { ...(payment.rawPayload ?? {}), callbackStatus: verified.status } },
    });
    if (count === 1 && verified.status === 'PAID') {
      await tx.subOrder.updateMany({ where: { id: payment.subOrderId, paymentStatus: { not: 'PAID' } }, data: { paymentStatus: 'PAID' } });
    }
    return count === 1;
  });
  const now = await prisma.payment.findUnique({ where: { id: payment.id }, select: { status: true } });
  return { received: true, duplicate: !changed, status: now.status };
}

// Refunds PAID payments through the provider that took them (mock: nothing to call; a provider
// that is not connected yet answers 501, so the cancel does not pretend money went back).
export async function refundPayments(payments) {
  for (const p of payments) await (paymentAdapter(p.provider) ?? paymentAdapter('mock')).refund(p);
}

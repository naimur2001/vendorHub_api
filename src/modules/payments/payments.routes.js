import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { validateQuery } from '../../middlewares/validate.js';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import * as s from './payments.service.js';

// Mounted at /api/v1.
const router = Router();

// admin: the active adapter modes and the latest outgoing messages (phones masked)
router.get(
  '/admin/message-log',
  authenticate,
  requireRole('ADMIN'),
  validateQuery(z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), orderId: z.uuid().optional() })),
  async (req, res) => {
    const { limit, orderId } = req.validated;
    const items = await prisma.messageLog.findMany({
      where: orderId ? { subOrderId: orderId } : {},
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, channel: true, provider: true, toMasked: true, template: true, body: true, status: true, error: true, subOrderId: true, createdAt: true },
    });
    res.json({ success: true, data: items, meta: { messagingMode: env.MESSAGING_MODE, paymentMode: env.PAYMENT_MODE } });
  },
);

// the customer starts paying an ONLINE order (the adapter of PAYMENT_MODE)
router.post('/orders/:orderId/payments', authenticate, async (req, res) => {
  res.status(201).json({ success: true, data: await s.createPayment(req.user.id, req.params.orderId) });
});

// the gateway's server-to-server callback: no login, the signature is the proof
router.post('/payments/callback/:provider', async (req, res) => {
  res.json({ success: true, data: await s.handleCallback(req.params.provider, req.headers, req.body) });
});

export default router;

import { Router } from 'express';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { listAdminOrdersQuery, adminChatQuery, adminCancelSchema, adminNoteSchema } from './adminOrders.schema.js';
import * as c from './adminOrders.controller.js';

const router = Router();
const adminOnly = [authenticate, requireRole('ADMIN')];

// a malformed id is "not found", like an unknown one
const uuidParam = (req, res, next) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.orderId)
    ? next()
    : res.status(404).json({ success: false, error: { message: 'Order not found' } });

// authenticate is applied per route because this router is mounted at /api/v1
router.get('/admin/orders', ...adminOnly, validateQuery(listAdminOrdersQuery), c.list);
router.get('/admin/orders/:orderId', ...adminOnly, uuidParam, c.get);
router.get('/admin/orders/:orderId/messages', ...adminOnly, uuidParam, validateQuery(adminChatQuery), c.chat);
router.post('/admin/orders/:orderId/cancel', ...adminOnly, uuidParam, validate(adminCancelSchema), c.cancel);
router.post('/admin/orders/:orderId/notes', ...adminOnly, uuidParam, validate(adminNoteSchema), c.addNote);
router.post('/admin/orders/:orderId/remind-shop', ...adminOnly, uuidParam, c.remind);

export default router;

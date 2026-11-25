import { Router } from 'express';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/auth.js';
import { chatLimiter } from '../../middlewares/rateLimit.js';
import { sendMessageSchema, listMessagesQuery } from './orderChat.schema.js';
import * as c from './orderChat.controller.js';
import { requireModule, checkLimit } from '../../lib/entitlements.js';


// Mounted at /api/v1. Who may see which order is checked in the service (the buyer, or the shop team).
// The web polls GET every ~10 s with ?after=<last id>; no websockets.
const router = Router();

router.get('/orders/:orderId/messages', authenticate, validateQuery(listMessagesQuery), c.customerList);
router.post('/orders/:orderId/messages', authenticate, chatLimiter, validate(sendMessageSchema), c.customerSend);
router.post('/orders/:orderId/messages/read', authenticate, c.customerRead);

router.get('/shops/:shopId/orders/:orderId/messages', authenticate, validateQuery(listMessagesQuery), c.shopList);
router.post('/shops/:shopId/orders/:orderId/messages', authenticate, requireModule('ORDER_CHAT'), chatLimiter, validate(sendMessageSchema), c.shopSend);
router.post('/shops/:shopId/orders/:orderId/messages/read', authenticate, c.shopRead);

export default router;

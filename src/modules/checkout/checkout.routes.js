import { Router } from 'express';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/auth.js';
import { checkoutSchema, listOrdersQuery } from './checkout.schema.js';
import * as c from './checkout.controller.js';
import { requireVerifiedEmail } from '../../middlewares/verifiedEmail.js';

const router = Router();

// authenticate is applied per route (not router.use) because this router is mounted at /api/v1,
// and router.use would turn every unknown /api/v1 path into a 401 instead of a 404.
router.post('/checkout', authenticate, requireVerifiedEmail, validate(checkoutSchema), c.checkout);
router.get('/checkouts/:checkoutId', authenticate, c.getCheckout);
router.get('/orders', authenticate, validateQuery(listOrdersQuery), c.listOrders);
router.get('/orders/:orderId', authenticate, c.getOrder);
router.post('/orders/:orderId/pay-mock', authenticate, c.payMock);

export default router;
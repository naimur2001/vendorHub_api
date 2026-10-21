import { Router } from 'express';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { listShopOrdersQuery, updateStatusSchema, cancelSchema } from './fulfilment.schema.js';
import * as c from './fulfilment.controller.js';

const router = Router();
const shopTeam = [authenticate, requireRole('SHOP_OWNER', 'SHOP_STAFF', 'ADMIN')];

// authenticate is applied per route because this router is mounted at /api/v1
router.get('/shops/:shopId/orders', ...shopTeam, validateQuery(listShopOrdersQuery), c.list);
router.get('/shops/:shopId/orders/:orderId', ...shopTeam, c.get);
router.post('/shops/:shopId/orders/:orderId/status', ...shopTeam, validate(updateStatusSchema), c.changeStatus);
router.post('/orders/:orderId/cancel', authenticate, validate(cancelSchema), c.cancel);

export default router;
import { Router } from 'express';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import * as c from './dashboards.controller.js';

const router = Router();

// authenticate is applied per route because this router is mounted at /api/v1
router.get('/dashboard/customer', authenticate, c.customer);
router.get('/dashboard/shop/:shopId', authenticate, requireRole('SHOP_OWNER', 'SHOP_STAFF', 'ADMIN'), c.shop);
router.get('/dashboard/admin', authenticate, requireRole('ADMIN'), c.admin);

export default router;
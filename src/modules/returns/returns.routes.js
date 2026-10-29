import { Router } from 'express';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import {
  createReturnSchema,
  listReturnsQuery,
  shopReturnsQuery,
  respondSchema,
  messageSchema,
  escalateSchema,
  disputesQuery,
  resolveSchema,
} from './returns.schema.js';
import * as c from './returns.controller.js';

const router = Router();
const shopTeam = [authenticate, requireRole('SHOP_OWNER', 'SHOP_STAFF', 'ADMIN')];
const adminOnly = [authenticate, requireRole('ADMIN')];

// authenticate is applied per route because this router is mounted at /api/v1
router.post('/orders/:orderId/returns', authenticate, validate(createReturnSchema), c.create);
router.get('/returns', authenticate, validateQuery(listReturnsQuery), c.listMine);
router.get('/returns/:id', authenticate, c.get);
router.post('/returns/:id/messages', authenticate, validate(messageSchema), c.addMessage);
router.post('/returns/:id/escalate', authenticate, validate(escalateSchema), c.escalate);
router.get('/shops/:shopId/returns', ...shopTeam, validateQuery(shopReturnsQuery), c.listForShop);
router.post('/returns/:id/respond', ...shopTeam, validate(respondSchema), c.respond);
router.get('/admin/disputes', ...adminOnly, validateQuery(disputesQuery), c.listDisputes);
router.post('/admin/returns/:id/resolve', ...adminOnly, validate(resolveSchema), c.resolve);

export default router;
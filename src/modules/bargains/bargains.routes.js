import { Router } from 'express';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate, optionalAuth, requireRole } from '../../middlewares/auth.js';
import {
  createBargainSchema,
  amountSchema,
  listBargainsQuery,
  shopInboxQuery,
} from './bargains.schema.js';
import * as c from './bargains.controller.js';

const router = Router();
const shopTeam = [authenticate, requireRole('SHOP_OWNER', 'SHOP_STAFF', 'ADMIN')];

// authenticate is applied per route because this router is mounted at /api/v1
router.get('/listings/:listingId/bargain-info', optionalAuth, c.info);
router.post('/bargains', authenticate, validate(createBargainSchema), c.create);
router.get('/bargains', authenticate, validateQuery(listBargainsQuery), c.list);
router.get('/bargains/:id', authenticate, c.get);
router.post('/bargains/:id/accept', authenticate, c.accept);
router.post('/bargains/:id/counter', authenticate, validate(amountSchema), c.counter);
router.post('/bargains/:id/decline', authenticate, c.decline);
router.post('/bargains/:id/add-to-cart', authenticate, c.addToCart);
router.get('/shops/:shopId/bargains', ...shopTeam, validateQuery(shopInboxQuery), c.shopInbox);

export default router;
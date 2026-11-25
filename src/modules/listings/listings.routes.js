import { Router } from 'express';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { createListingSchema, updateListingSchema, listListingsQuery } from './listings.schema.js';
import * as c from './listings.controller.js';
import { requireModule, checkLimit } from '../../lib/entitlements.js';
const bargainOn = (req) => req.body?.bargainEnabled === true || req.body?.listing?.bargainEnabled === true;


const router = Router();
const shopTeam = [authenticate, requireRole('SHOP_OWNER', 'SHOP_STAFF', 'ADMIN')];

router.get('/shops/:shopId/listings', ...shopTeam, requireModule('ANALYTICS', (req) => req.query.lowStock === 'true'), validateQuery(listListingsQuery), c.list);
router.post('/shops/:shopId/listings', ...shopTeam, validate(createListingSchema), checkLimit('maxProducts'), requireModule('BARGAINING', bargainOn), c.create);
router.patch('/shops/:shopId/listings/:listingId', ...shopTeam, validate(updateListingSchema), requireModule('BARGAINING', bargainOn), c.update);
router.delete('/shops/:shopId/listings/:listingId', ...shopTeam, c.remove);

export default router;
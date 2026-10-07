import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { createListingSchema, updateListingSchema } from './listings.schema.js';
import * as c from './listings.controller.js';

const router = Router();
const shopTeam = [authenticate, requireRole('SHOP_OWNER', 'SHOP_STAFF', 'ADMIN')];

router.get('/shops/:shopId/listings', ...shopTeam, c.list);
router.post('/shops/:shopId/listings', ...shopTeam, validate(createListingSchema), c.create);
router.patch('/shops/:shopId/listings/:listingId', ...shopTeam, validate(updateListingSchema), c.update);
router.delete('/shops/:shopId/listings/:listingId', ...shopTeam, c.remove);

export default router;
import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { addStaffSchema } from './staff.schema.js';
import * as c from './staff.controller.js';

const router = Router();
const shopTeam = [authenticate, requireRole('SHOP_OWNER', 'SHOP_STAFF', 'ADMIN')];
const owner = [authenticate, requireRole('SHOP_OWNER', 'ADMIN')];

// authenticate is applied per route because this router is mounted at /api/v1
router.get('/shops/:shopId/staff', ...shopTeam, c.list);
router.post('/shops/:shopId/staff', ...owner, validate(addStaffSchema), c.add);
router.delete('/shops/:shopId/staff/:userId', ...owner, c.remove);

export default router;
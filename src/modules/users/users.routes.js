import { Router } from 'express';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import {
  updateProfileSchema,
  addressSchema,
  addressUpdateSchema,
  adminUsersQuery,
  userStatusSchema,
  userRoleSchema,
} from './users.schema.js';
import * as c from './users.controller.js';

const router = Router();
const adminOnly = [authenticate, requireRole('ADMIN')];

// authenticate is applied per route because this router is mounted at /api/v1
router.patch('/users/me', authenticate, validate(updateProfileSchema), c.updateProfile);
router.get('/users/me/addresses', authenticate, c.listAddresses);
router.post('/users/me/addresses', authenticate, validate(addressSchema), c.createAddress);
router.patch('/users/me/addresses/:id', authenticate, validate(addressUpdateSchema), c.updateAddress);
router.delete('/users/me/addresses/:id', authenticate, c.deleteAddress);

router.get('/admin/users', ...adminOnly, validateQuery(adminUsersQuery), c.listUsers);
router.get('/admin/users/:id', ...adminOnly, c.getUser);
router.patch('/admin/users/:id/status', ...adminOnly, validate(userStatusSchema), c.setStatus);
router.patch('/admin/users/:id/role', ...adminOnly, validate(userRoleSchema), c.setRole);

export default router;
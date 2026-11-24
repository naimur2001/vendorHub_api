import { Router } from 'express';
import { z } from 'zod';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { deletionRequestSchema, rejectSchema, adminListQuery, shopListQuery } from './productDeletion.schema.js';
import * as c from './productDeletion.controller.js';

const router = Router();
const adminOnly = [authenticate, requireRole('ADMIN')];

// Path ids must be UUIDs (ZodError -> 400 "Validation failed").
const uuids = (...names) => {
  const schema = z.object(Object.fromEntries(names.map((n) => [n, z.uuid()])));
  return (req, res, next) => {
    schema.parse(req.params);
    next();
  };
};

// Shop owner only (checked in the service: staff and admins get 403).
router.post(
  '/shops/:shopId/products/:productId/deletion-request',
  authenticate,
  uuids('shopId', 'productId'),
  validate(deletionRequestSchema),
  c.request,
);
router.get('/shops/:shopId/deletion-requests', authenticate, uuids('shopId'), validateQuery(shopListQuery), c.listShop);
router.delete('/shops/:shopId/deletion-requests/:id', authenticate, uuids('shopId', 'id'), c.cancel);

// Admin
router.get('/admin/deletion-requests', ...adminOnly, validateQuery(adminListQuery), c.listAdmin);
router.post('/admin/deletion-requests/:id/reject', ...adminOnly, uuids('id'), validate(rejectSchema), c.reject);
router.post('/admin/deletion-requests/:id/approve', ...adminOnly, uuids('id'), c.approve);
router.delete('/admin/products/:id/permanent', ...adminOnly, uuids('id'), c.deletePermanently);

export default router;

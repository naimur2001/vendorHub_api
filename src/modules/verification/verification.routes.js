import { Router } from 'express';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import {
  submitVerificationSchema,
  resubmitSchema,
  reviewDocumentSchema,
  notesSchema,
  requestCorrectionSchema,
  rejectSchema,
  revokeSchema,
  adminQuery,
  auditQuery,
} from './verification.schema.js';
import * as c from './verification.controller.js';

const router = Router();
const owner = [authenticate, requireRole('SHOP_OWNER', 'ADMIN')];
const shopTeam = [authenticate, requireRole('SHOP_OWNER', 'SHOP_STAFF', 'ADMIN')];
const adminOnly = [authenticate, requireRole('ADMIN')];

// shop owner side (authenticate is applied per route because this router is mounted at /api/v1)
router.post('/shops/:shopId/verifications', ...owner, validate(submitVerificationSchema), c.submit);
router.get('/shops/:shopId/verifications', ...shopTeam, c.listForShop);
router.post('/verifications/:id/resubmit', ...owner, validate(resubmitSchema), c.resubmit);

// admin portal
router.get('/admin/verifications', ...adminOnly, validateQuery(adminQuery), c.adminList);
router.get('/admin/verifications/:id', ...adminOnly, c.adminDetail);
router.patch('/admin/verifications/:id/notes', ...adminOnly, validate(notesSchema), c.setNotes);
router.patch('/admin/verifications/:id/documents/:docId', ...adminOnly, validate(reviewDocumentSchema), c.reviewDocument);
router.post('/admin/verifications/:id/approve', ...adminOnly, c.approve);
router.post('/admin/verifications/:id/request-correction', ...adminOnly, validate(requestCorrectionSchema), c.requestCorrection);
router.post('/admin/verifications/:id/reject', ...adminOnly, validate(rejectSchema), c.reject);
router.post('/admin/shops/:shopId/revoke', ...adminOnly, validate(revokeSchema), c.revoke);
router.get('/admin/audit-logs', ...adminOnly, validateQuery(auditQuery), c.auditLogs);

export default router;
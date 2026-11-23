import { Router } from 'express';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate, optionalAuth, requireRole } from '../../middlewares/auth.js';
import { toLetLimiter } from '../../middlewares/rateLimit.js';
import { receivePhoto, receiveDocument } from '../../middlewares/photoUpload.js';
import {
  createToLetSchema, updateToLetSchema, confirmEmailSchema, manageQuery, listToLetQuery, inquirySchema,
  messageSchema, messagesQuery, adminListQuery, requestInfoSchema, rejectSchema, noteSchema, inquiryStatusSchema,
} from './toLet.schema.js';
import * as c from './toLet.controller.js';

const router = Router();
const adminOnly = [authenticate, requireRole('ADMIN')];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// malformed ids are "not found", like unknown ones
const ids = (...names) => (req, res, next) =>
  names.every((n) => UUID.test(req.params[n]))
    ? next()
    : res.status(404).json({ success: false, error: { message: 'Not found' } });

// authenticate / optionalAuth are applied per route because this router is mounted at /api/v1

// ---------- owner (login, or a guest's X-Manage-Token header) ----------
router.post('/to-let', toLetLimiter, optionalAuth, validate(createToLetSchema), c.create);
router.post('/to-let/confirm-email', toLetLimiter, validate(confirmEmailSchema), c.confirmEmail);
router.get('/to-let/manage', validateQuery(manageQuery), c.manage);
router.get('/me/to-let', authenticate, c.mine);
router.patch('/to-let/:id', optionalAuth, ids('id'), validate(updateToLetSchema), c.update);
router.post('/to-let/:id/withdraw', optionalAuth, ids('id'), c.withdraw);
router.post('/to-let/:id/photos', optionalAuth, ids('id'), toLetLimiter, receivePhoto, c.addPhoto);
router.delete('/to-let/:id/photos/:photoId', optionalAuth, ids('id', 'photoId'), c.removePhoto);
router.post('/to-let/:id/documents', optionalAuth, ids('id'), toLetLimiter, receiveDocument, c.addDocument);
router.get('/to-let/:id/messages', optionalAuth, ids('id'), c.ownerMessages);
router.post('/to-let/:id/messages', optionalAuth, ids('id'), validate(messageSchema), c.ownerSend);

// ---------- enquiries (login, or a guest's follow token: ?token= or X-Follow-Token) ----------
router.post('/to-let/:id/inquiries', toLetLimiter, optionalAuth, ids('id'), validate(inquirySchema), c.inquire);
router.get('/to-let/inquiries/:id/messages', optionalAuth, ids('id'), validateQuery(messagesQuery), c.inquiryMessages);
router.post('/to-let/inquiries/:id/messages', optionalAuth, ids('id'), validate(messageSchema), c.inquirySend);

// ---------- public ----------
router.get('/to-let', validateQuery(listToLetQuery), c.list);
router.get('/to-let/:slug', c.get);

// ---------- admin (all audited) ----------
router.get('/admin/to-let', ...adminOnly, validateQuery(adminListQuery), c.adminList);
router.get('/admin/to-let/:id', ...adminOnly, ids('id'), c.adminGet);
router.get('/admin/to-let/:id/documents/:docId', ...adminOnly, ids('id', 'docId'), c.adminDocument);
router.post('/admin/to-let/:id/publish', ...adminOnly, ids('id'), c.publish);
router.post('/admin/to-let/:id/request-info', ...adminOnly, ids('id'), validate(requestInfoSchema), c.requestInfo);
router.post('/admin/to-let/:id/reject', ...adminOnly, ids('id'), validate(rejectSchema), c.reject);
router.post('/admin/to-let/:id/mark-rented', ...adminOnly, ids('id'), c.markRented);
router.post('/admin/to-let/:id/renew', ...adminOnly, ids('id'), c.renew);
router.post('/admin/to-let/:id/notes', ...adminOnly, ids('id'), validate(noteSchema), c.addNote);
router.post('/admin/to-let/:id/messages', ...adminOnly, ids('id'), validate(messageSchema), c.replyOwner);
router.post('/admin/to-let/inquiries/:id/messages', ...adminOnly, ids('id'), validate(messageSchema), c.replyInquiry);
router.patch('/admin/to-let/inquiries/:id', ...adminOnly, ids('id'), validate(inquiryStatusSchema), c.inquiryStatus);
router.post('/admin/to-let/inquiries/:id/share-contacts', ...adminOnly, ids('id'), c.shareContacts);

export default router;

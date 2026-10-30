import { Router } from 'express';
import { validateQuery } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/auth.js';
import { listNotificationsQuery } from './notifications.schema.js';
import * as c from './notifications.controller.js';

const router = Router();

// authenticate is applied per route because this router is mounted at /api/v1
router.get('/notifications', authenticate, validateQuery(listNotificationsQuery), c.list);
router.get('/notifications/unread-count', authenticate, c.unreadCount);
router.post('/notifications/read-all', authenticate, c.markAllRead);
router.post('/notifications/:id/read', authenticate, c.markRead);

export default router;
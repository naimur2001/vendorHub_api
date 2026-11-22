import { Router } from 'express';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { myCredit } from './referrals.service.js';

// Mounted at /api/v1. The customer's credit balance, history and referral code.
const router = Router();
router.get('/me/credit', authenticate, requireRole('CUSTOMER'), async (req, res) => {
  res.json({ success: true, data: await myCredit(req.user.id) });
});

export default router;

import { Router } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { optionalAuth } from '../../middlewares/auth.js';
import { receiveFileField } from '../../middlewares/photoUpload.js';
import { searchByImage } from './search.service.js';

const router = Router();
const tooMany = { success: false, error: { message: 'Too many photo searches. Please try again later.' } };

// Always on (also in development): every attempt counts, because each one can cost an AI call.
const guestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  skip: (req) => Boolean(req.user),
  keyGenerator: (req) => `search-guest:${ipKeyGenerator(req.ip)}`,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: tooMany,
});
const userLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: 30,
  skip: (req) => !req.user,
  keyGenerator: (req) => `search-user:${req.user.id}`,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: tooMany,
});

// the photo is never stored and the answer is never cached
const noStore = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

router.post('/search/by-image', noStore, optionalAuth, guestLimiter, userLimiter, receiveFileField('photo'), async (req, res) => {
  res.json({ success: true, data: await searchByImage(req.file) });
});

export default router;
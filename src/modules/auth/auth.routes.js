import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/auth.js';
import { authLimiter, failedAttemptLimiter } from '../../middlewares/rateLimit.js';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from './auth.schema.js';
import * as controller from './auth.controller.js';

const router = Router();

// rate limits: registrations all count; for login and change-password only FAILED attempts count
router.post('/register', authLimiter, validate(registerSchema), controller.register);
router.post('/login', failedAttemptLimiter, validate(loginSchema), controller.login);
router.post('/refresh', validate(refreshSchema), controller.refresh);
router.post('/logout', validate(refreshSchema), controller.logout);
router.post('/change-password', authenticate, failedAttemptLimiter, validate(changePasswordSchema), controller.changePassword);
router.post('/forgot-password', authLimiter, validate(forgotPasswordSchema), controller.forgotPassword);
router.post('/reset-password', authLimiter, validate(resetPasswordSchema), controller.resetPassword);
router.get('/me', authenticate, controller.me);

export default router;
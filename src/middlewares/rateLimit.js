import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';

// Off in development (so the test scripts can log in freely), on in production.
// RATE_LIMIT_ENABLED=true/false overrides this.
export const rateLimitEnabled = env.RATE_LIMIT_ENABLED ?? env.NODE_ENV === 'production';

const make = (limit, extra = {}) =>
  rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => !rateLimitEnabled,
    message: { success: false, error: { message: 'Too many requests. Please try again later.' } },
    ...extra,
  });

// Every API request, per IP.
export const globalLimiter = make(env.RATE_LIMIT_GLOBAL_MAX);

// Registration: every attempt counts.
export const authLimiter = make(env.RATE_LIMIT_AUTH_MAX);

// Login and change-password: only FAILED attempts count, so real users are never locked out
// but password guessing is stopped. (The counter lives in memory and resets when the server restarts.)
export const failedAttemptLimiter = make(env.RATE_LIMIT_AUTH_MAX, { skipSuccessfulRequests: true });
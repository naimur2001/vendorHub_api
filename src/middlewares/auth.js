import { AppError } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { prisma } from '../lib/prisma.js';

// While an account waits for deletion, only these logged-in calls stay possible (to see the state and to cancel).
// /auth/refresh and /auth/logout do not use authenticate, so they keep working too.
const ALLOWED_WHILE_DELETION_PENDING = new Set(['GET /api/v1/auth/me', 'DELETE /api/v1/users/me/deletion']);

// Requires header:  Authorization: Bearer <accessToken>
export async function authenticate(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) throw new AppError(401, 'Authentication required');
  const payload = verifyAccessToken(token);
  req.user = { id: payload.sub, role: payload.role };

  // one primary-key lookup: a deletion request blocks at once, also for access tokens issued before it
  const account = await prisma.user.findUnique({ where: { id: payload.sub }, select: { deletionScheduledFor: true } });
  if (account?.deletionScheduledFor) {
    const route = `${req.method} ${req.originalUrl.split('?')[0]}`;
    if (!ALLOWED_WHILE_DELETION_PENDING.has(route)) {
      throw new AppError(403, 'Your account is scheduled for deletion', {
        code: 'ACCOUNT_DELETION_PENDING',
        deletionScheduledFor: account.deletionScheduledFor.toISOString(),
      });
    }
  }
  next();
}

// Like authenticate, but never fails: sets req.user only when a valid token is sent (public routes).
export function optionalAuth(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Bearer' && token) {
    try {
      const payload = verifyAccessToken(token);
      req.user = { id: payload.sub, role: payload.role };
    } catch {
      // invalid token on a public route: treat as anonymous
    }
  }
  next();
}

// Usage: router.get('/x', authenticate, requireRole('ADMIN', 'SHOP_OWNER'), handler)
export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    throw new AppError(403, 'You do not have permission to do this');
  }
  next();
};
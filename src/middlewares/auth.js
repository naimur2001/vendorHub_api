import { AppError } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/jwt.js';

// Requires header:  Authorization: Bearer <accessToken>
export function authenticate(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) throw new AppError(401, 'Authentication required');
  const payload = verifyAccessToken(token);
  req.user = { id: payload.sub, role: payload.role };
  next();
}

// Usage: router.get('/x', authenticate, requireRole('ADMIN', 'SHOP_OWNER'), handler)
export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    throw new AppError(403, 'You do not have permission to do this');
  }
  next();
};

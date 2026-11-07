// Blocks important write actions (checkout, offers, shops, reviews...) until the email is verified.
// Admins are never blocked. Read from the database, so a fresh verification counts at once.
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';

export async function requireVerifiedEmail(req, res, next) {
  if (req.user.role === 'ADMIN') return next();
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { emailVerifiedAt: true } });
  if (!user?.emailVerifiedAt) {
    return next(new AppError(403, 'Please verify your email first', { code: 'EMAIL_NOT_VERIFIED' }));
  }
  return next();
}
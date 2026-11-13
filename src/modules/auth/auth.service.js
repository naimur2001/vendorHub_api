import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { signAccessToken } from '../../lib/jwt.js';
// import { env } from '../../config/env.js';
import { env } from '../../config/env.js';
import { sendMail } from '../../lib/mailer.js';
import { logger } from '../../lib/logger.js';

// We store only a hash of the refresh token, so a DB leak does not leak usable tokens.
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  role: u.role,
  avatarUrl: u.avatarUrl,
  emailVerified: Boolean(u.emailVerifiedAt),
  deletionScheduledFor: u.deletionScheduledFor ? u.deletionScheduledFor.toISOString() : null,
});

async function issueTokens(user) {
  const accessToken = signAccessToken({ sub: user.id, role: user.role });
  const refreshToken = crypto.randomBytes(48).toString('hex');
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000),
    },
  });
  return { accessToken, refreshToken };
}

export async function register({ name, email, phone, password, role }) {
  const existing = await prisma.user.findFirst({
    where: { OR: [{ email }, ...(phone ? [{ phone }] : [])] },
  });
  if (existing) throw new AppError(409, 'Email or phone is already registered');

  const passwordHash = await bcrypt.hash(password, 10);
  // const user = await prisma.user.create({ data: { name, email, phone, passwordHash, role } });
  const verified = isAutoVerified(email); // development/test domains only (never in production)
  const user = await prisma.user.create({
    data: { name, email, phone, passwordHash, role, emailVerifiedAt: verified ? new Date() : null },
  });
  if (!verified && user.email) await sendVerificationLink(user); // never throws: a mail problem must not stop registration
  return { user: publicUser(user), ...(await issueTokens(user)) };
}

export async function login({ email, password }) {
  const user = await prisma.user.findUnique({ where: { email } });
  const valid = user && user.isActive && (await bcrypt.compare(password, user.passwordHash));
  // Same message for "no such user" and "wrong password" so attackers cannot probe for emails.
  if (!valid) throw new AppError(401, 'Invalid email or password');
  return { user: publicUser(user), ...(await issueTokens(user)) };
}

// Refresh-token rotation: every refresh revokes the old token and issues a new one.
export async function refresh(refreshToken) {
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(refreshToken) },
    include: { user: true },
  });
  if (!record || record.revokedAt || record.expiresAt < new Date() || !record.user.isActive) {
    throw new AppError(401, 'Invalid refresh token');
  }
  await prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
  return { user: publicUser(record.user), ...(await issueTokens(record.user)) };
}

export async function logout(refreshToken) {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function getMe(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, 'User not found');
  return publicUser(user);
}

//change password



export async function changePassword(userId, { oldPassword, newPassword }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, 'User not found');

  // 400, not 401: a 401 would make a frontend think the session expired and log the user out
  const ok = await bcrypt.compare(oldPassword, user.passwordHash);
  if (!ok) throw new AppError(400, 'Old password is incorrect');

  const passwordHash = await bcrypt.hash(newPassword, 10);
  // one transaction: new password + revoke every refresh token (forces login on other devices)
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}










const RESET_TOKEN_MINUTES = 60;

// Always succeeds from the caller's point of view, so nobody can find out which emails are registered.
export async function forgotPassword({ email }) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.isActive) return;

  const token = crypto.randomBytes(48).toString('hex');
  await prisma.$transaction([
    // older unused links stop working
    prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    }),
    // only the hash of the token is stored
    prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + RESET_TOKEN_MINUTES * 60 * 1000),
      },
    }),
  ]);

  const link = `${env.APP_URL}/reset-password?token=${token}`;
  try {
    await sendMail({
      to: user.email,
      subject: 'Reset your Vendors Hub password',
      text: [
        `Hello ${user.name},`,
        '',
        'We received a request to reset your Vendors Hub password.',
        `Open this link within ${RESET_TOKEN_MINUTES} minutes to choose a new password:`,
        link,
        '',
        'If you did not ask for this, ignore this message. Your password stays the same.',
      ].join('\n'),
    });
  } catch (err) {
    // a mail problem must not change the answer (that would reveal that the email exists)
    logger.error(err, 'could not send the password reset mail');
  }
}

export async function resetPassword({ token, newPassword }) {
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!record || record.usedAt || record.expiresAt < new Date() || !record.user.isActive) {
    throw new AppError(400, 'Invalid or expired reset link');
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.$transaction(async (tx) => {
    // conditional update: if two requests use the same link, only the first one wins
    const used = await tx.passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (used.count !== 1) throw new AppError(400, 'Invalid or expired reset link');

    await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
    // every device is logged out
    await tx.refreshToken.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });
}



// ---------- email verification ----------
const VERIFY_HOURS = 24;
const RESEND_PER_HOUR = 3;
const INVALID_LINK = 'This link is invalid or has expired';

const autoDomains = (env.AUTO_VERIFY_EMAIL_DOMAINS ?? '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);
function isAutoVerified(email) {
  const domain = String(email ?? '').split('@')[1]?.toLowerCase();
  return Boolean(domain) && autoDomains.includes(domain);
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// A new link: random 32 bytes, only the SHA-256 is stored; older unused links stop working.
// Never throws: problems are logged, so registration and resend answer the same way.
async function sendVerificationLink(user) {
  try {
    const token = crypto.randomBytes(32).toString('hex');
    const now = new Date();
    await prisma.$transaction([
      prisma.emailVerificationToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } }),
      prisma.emailVerificationToken.create({
        data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + VERIFY_HOURS * 3600 * 1000) },
      }),
    ]);
    const link = `${env.APP_URL}/auth/verify-email?token=${token}`;
    const text = [
      `Hello ${user.name},`,
      '',
      'Please confirm your email address for Vendors Hub:',
      link,
      '',
      `The link works for ${VERIFY_HOURS} hours. If you did not create an account, ignore this email.`,
    ].join('\n');
    const html =
      `<p>Hello ${escapeHtml(user.name)},</p>` +
      '<p>Please confirm your email address for Vendors Hub:</p>' +
      `<p><a href="${link}">Confirm my email</a></p>` +
      `<p>The link works for ${VERIFY_HOURS} hours. If you did not create an account, ignore this email.</p>`;
    await sendMail({ to: user.email, subject: 'Confirm your email for Vendors Hub', text, html });
  } catch (err) {
    logger.error({ err: err.message, userId: user.id }, 'verification email could not be prepared or sent');
  }
}

// Used or expired links always fail (400). A valid link for an already verified user answers 200.
export async function verifyEmail({ token }) {
  const row = await prisma.emailVerificationToken.findUnique({ where: { tokenHash: hashToken(token) } });
  const now = new Date();
  if (!row || row.usedAt || row.expiresAt <= now) throw new AppError(400, INVALID_LINK);
  const user = await prisma.user.findUnique({ where: { id: row.userId } });
  if (!user) throw new AppError(400, INVALID_LINK);

  await prisma.$transaction(async (tx) => {
    // conditional: a link works once, even when it is clicked twice at the same moment
    const used = await tx.emailVerificationToken.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (used.count === 0) throw new AppError(400, INVALID_LINK);
    if (!user.emailVerifiedAt) {
      await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: now } });
      await tx.auditLog.create({
        data: { actorId: user.id, action: 'auth.email_verified', entityType: 'User', entityId: user.id, meta: {} },
      });
    }
  });
  return { verified: true };
}

// At most RESEND_PER_HOUR verification emails per user per hour (the registration email counts too).
export async function resendVerification(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, 'User not found');
  if (user.emailVerifiedAt) return { alreadyVerified: true };
  const recent = await prisma.emailVerificationToken.count({
    where: { userId, createdAt: { gte: new Date(Date.now() - 3600 * 1000) } },
  });
  if (recent >= RESEND_PER_HOUR) throw new AppError(429, 'Too many verification emails. Please try again later.');
  await sendVerificationLink(user);
  return { alreadyVerified: false, message: 'A new verification link has been sent.' };
}
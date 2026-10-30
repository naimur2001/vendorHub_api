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
  const user = await prisma.user.create({ data: { name, email, phone, passwordHash, role } });
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
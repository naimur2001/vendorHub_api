import { prisma } from './prisma.js';
import { logger } from './logger.js';

// Creates in-app notifications. Best effort: call it AFTER a transaction has committed.
// It never throws, so a notification problem can never break or undo the action that caused it.
// (Email or SMS can be added here later, the same way the mailer works.)
export async function notify(userIds, { type, title, body, data }) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return;
  try {
    await prisma.notification.createMany({
      data: ids.map((userId) => ({ userId, type, title, body, data })),
    });
  } catch (err) {
    logger.error(err, 'could not create notifications');
  }
}
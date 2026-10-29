import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';

const present = (n) => ({
  id: n.id,
  type: n.type,
  title: n.title,
  body: n.body,
  data: n.data,
  read: n.readAt !== null,
  readAt: n.readAt,
  createdAt: n.createdAt,
});

export async function list(user, { unreadOnly, page, limit }) {
  const where = { userId: user.id, ...(unreadOnly && { readAt: null }) };
  const [total, rows] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  return {
    items: rows.map(present),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function unreadCount(user) {
  return { unread: await prisma.notification.count({ where: { userId: user.id, readAt: null } }) };
}

// Other people's notifications return 404.
export async function markRead(user, id) {
  const n = await prisma.notification.findFirst({ where: { id, userId: user.id } });
  if (!n) throw new AppError(404, 'Notification not found');
  if (n.readAt) return present(n);
  return present(await prisma.notification.update({ where: { id }, data: { readAt: new Date() } }));
}

export async function markAllRead(user) {
  const r = await prisma.notification.updateMany({
    where: { userId: user.id, readAt: null },
    data: { readAt: new Date() },
  });
  return { marked: r.count };
}
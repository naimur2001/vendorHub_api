import * as notificationService from './notifications.service.js';

export const list = async (req, res) => {
  const { items, pagination } = await notificationService.list(req.user, req.validated);
  res.json({ success: true, data: items, meta: { pagination } });
};

export const unreadCount = async (req, res) => {
  res.json({ success: true, data: await notificationService.unreadCount(req.user) });
};

export const markRead = async (req, res) => {
  res.json({ success: true, data: await notificationService.markRead(req.user, req.params.id) });
};

export const markAllRead = async (req, res) => {
  res.json({ success: true, data: await notificationService.markAllRead(req.user) });
};
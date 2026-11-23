import * as s from './adminOrders.service.js';

export const list = async (req, res) => {
  const { items, counts, pagination } = await s.listOrders(req.user, req.validated);
  res.json({ success: true, data: items, meta: { counts, pagination } });
};

export const get = async (req, res) => {
  res.json({ success: true, data: await s.getOrder(req.user, req.params.orderId) });
};

export const chat = async (req, res) => {
  res.json({ success: true, data: await s.getChat(req.user, req.params.orderId, req.validated.after) });
};

export const cancel = async (req, res) => {
  res.json({ success: true, data: await s.cancelOrder(req.user, req.params.orderId, req.body.reason) });
};

export const addNote = async (req, res) => {
  res.status(201).json({ success: true, data: await s.addNote(req.user, req.params.orderId, req.body.body) });
};

export const remind = async (req, res) => {
  res.json({ success: true, data: await s.remindShop(req.user, req.params.orderId) });
};

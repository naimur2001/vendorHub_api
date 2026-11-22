import * as s from './orderChat.service.js';

const ok = (res, data) => res.json({ success: true, data });

export const customerList = async (req, res) => ok(res, await s.customerList(req.user.id, req.params.orderId, req.validated.after));
export const customerSend = async (req, res) =>
  res.status(201).json({ success: true, data: await s.customerSend(req.user, req.params.orderId, req.body.body) });
export const customerRead = async (req, res) => ok(res, await s.customerRead(req.user.id, req.params.orderId));

export const shopList = async (req, res) =>
  ok(res, await s.shopList(req.user, req.params.shopId, req.params.orderId, req.validated.after));
export const shopSend = async (req, res) =>
  res.status(201).json({ success: true, data: await s.shopSend(req.user, req.params.shopId, req.params.orderId, req.body.body) });
export const shopRead = async (req, res) => ok(res, await s.shopRead(req.user, req.params.shopId, req.params.orderId));

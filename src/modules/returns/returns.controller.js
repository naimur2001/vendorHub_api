import * as returnService from './returns.service.js';

export const create = async (req, res) => {
  const data = await returnService.createReturn(req.user, req.params.orderId, req.body);
  res.status(201).json({ success: true, data });
};

export const listMine = async (req, res) => {
  const { items, pagination } = await returnService.listMine(req.user, req.validated);
  res.json({ success: true, data: items, meta: { pagination } });
};

export const get = async (req, res) => {
  res.json({ success: true, data: await returnService.getReturn(req.user, req.params.id) });
};

export const listForShop = async (req, res) => {
  const { items, pagination } = await returnService.listForShop(req.user, req.params.shopId, req.validated);
  res.json({ success: true, data: items, meta: { pagination } });
};

export const respond = async (req, res) => {
  res.json({ success: true, data: await returnService.respond(req.user, req.params.id, req.body) });
};

export const addMessage = async (req, res) => {
  const data = await returnService.addMessage(req.user, req.params.id, req.body);
  res.status(201).json({ success: true, data });
};

export const escalate = async (req, res) => {
  res.json({ success: true, data: await returnService.escalate(req.user, req.params.id, req.body) });
};

export const listDisputes = async (req, res) => {
  const { items, pagination } = await returnService.listDisputes(req.validated);
  res.json({ success: true, data: items, meta: { pagination } });
};

export const resolve = async (req, res) => {
  res.json({ success: true, data: await returnService.resolve(req.user, req.params.id, req.body) });
};
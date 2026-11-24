import * as s from './productDeletion.service.js';

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const list = (res, { items, pagination }) => res.json({ success: true, data: items, meta: { pagination } });

export const request = async (req, res) =>
  ok(res, await s.requestDeletion(req.user, req.params.shopId, req.params.productId, req.body), 201);
export const cancel = async (req, res) => ok(res, await s.cancelRequest(req.user, req.params.shopId, req.params.id));
export const listShop = async (req, res) => list(res, await s.listShopRequests(req.user, req.params.shopId, req.validated));

export const listAdmin = async (req, res) => list(res, await s.listAdminRequests(req.validated));
export const reject = async (req, res) => ok(res, await s.rejectRequest(req.user, req.params.id, req.body));
export const approve = async (req, res) => ok(res, await s.approveRequest(req.user, req.params.id));
export const deletePermanently = async (req, res) => ok(res, await s.deletePermanently(req.user, req.params.id));

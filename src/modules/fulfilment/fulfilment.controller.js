import * as fulfilmentService from './fulfilment.service.js';

export const list = async (req, res) => {
  const { items, pagination } = await fulfilmentService.listShopOrders(
    req.user,
    req.params.shopId,
    req.validated,
  );
  res.json({ success: true, data: items, meta: { pagination } });
};

export const get = async (req, res) => {
  const { shopId, orderId } = req.params;
  res.json({ success: true, data: await fulfilmentService.getShopOrder(req.user, shopId, orderId) });
};

export const changeStatus = async (req, res) => {
  const { shopId, orderId } = req.params;
  const data = await fulfilmentService.changeStatus(req.user, shopId, orderId, req.body);
  res.json({ success: true, data });
};

export const cancel = async (req, res) => {
  const data = await fulfilmentService.cancelByCustomer(req.user.id, req.params.orderId, req.body.reason);
  res.json({ success: true, data });
};
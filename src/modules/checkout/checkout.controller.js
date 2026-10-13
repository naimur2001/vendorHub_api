import * as checkoutService from './checkout.service.js';

export const checkout = async (req, res) => {
  const data = await checkoutService.placeOrders(req.user.id, req.body);
  res.status(201).json({ success: true, data });
};

export const getCheckout = async (req, res) => {
  const data = await checkoutService.getCheckout(req.user.id, req.params.checkoutId);
  res.json({ success: true, data });
};

export const listOrders = async (req, res) => {
  const { items, pagination } = await checkoutService.listOrders(req.user.id, req.validated);
  res.json({ success: true, data: items, meta: { pagination } });
};

export const getOrder = async (req, res) => {
  const data = await checkoutService.getOrder(req.user.id, req.params.orderId);
  res.json({ success: true, data });
};

export const payMock = async (req, res) => {
  const data = await checkoutService.payMock(req.user.id, req.params.orderId);
  res.json({ success: true, data });
};
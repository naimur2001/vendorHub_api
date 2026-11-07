import * as checkoutService from './checkout.service.js';

// Optional header Idempotency-Key: a repeated request returns the stored answer instead of new orders.
export const checkout = async (req, res) => {
  const key = req.get('Idempotency-Key');
  if (key === undefined) {
    const data = await checkoutService.placeOrders(req.user.id, req.body);
    return res.status(201).json({ success: true, data });
  }
  const r = await checkoutService.placeOrdersIdempotent(req.user.id, req.body, key);
  if (r.replayed) {
    res.set('Idempotent-Replayed', 'true');
    return res.status(r.status).type('json').send(r.raw); // the stored text, unchanged
  }
  return res.status(r.status).json(r.body);
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
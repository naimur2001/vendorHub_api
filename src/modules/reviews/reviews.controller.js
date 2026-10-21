import * as reviewService from './reviews.service.js';

export const create = async (req, res) => {
  const data = await reviewService.createReview(req.user, req.body);
  res.status(201).json({ success: true, data });
};

export const update = async (req, res) => {
  const data = await reviewService.updateReview(req.user, req.params.id, req.body);
  res.json({ success: true, data });
};

export const remove = async (req, res) => {
  await reviewService.deleteReview(req.user, req.params.id);
  res.json({ success: true, data: { message: 'Review deleted' } });
};

export const productReviews = async (req, res) => {
  const { items, pagination, summary } = await reviewService.productReviews(req.params.slug, req.validated);
  res.json({ success: true, data: items, meta: { pagination, summary } });
};
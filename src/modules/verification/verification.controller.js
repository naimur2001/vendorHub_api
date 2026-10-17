import * as verificationService from './verification.service.js';

export const submit = async (req, res) => {
  const data = await verificationService.submitVerification(req.user, req.params.shopId, req.body);
  res.status(201).json({ success: true, data });
};

export const listForShop = async (req, res) => {
  const data = await verificationService.listForShop(req.user, req.params.shopId);
  res.json({ success: true, data });
};

export const resubmit = async (req, res) => {
  const data = await verificationService.resubmit(req.user, req.params.id, req.body.documents);
  res.json({ success: true, data });
};

export const adminList = async (req, res) => {
  const { items, pagination, stats } = await verificationService.adminList(req.validated);
  res.json({ success: true, data: items, meta: { pagination, stats } });
};

export const adminDetail = async (req, res) => {
  res.json({ success: true, data: await verificationService.getForAdmin(req.params.id) });
};

export const setNotes = async (req, res) => {
  const data = await verificationService.setNotes(req.params.id, req.body.notes);
  res.json({ success: true, data });
};

export const reviewDocument = async (req, res) => {
  const { id, docId } = req.params;
  const data = await verificationService.reviewDocument(id, docId, req.body.reviewed);
  res.json({ success: true, data });
};

export const approve = async (req, res) => {
  res.json({ success: true, data: await verificationService.approve(req.user, req.params.id) });
};

export const requestCorrection = async (req, res) => {
  const data = await verificationService.requestCorrection(req.user, req.params.id, req.body);
  res.json({ success: true, data });
};

export const reject = async (req, res) => {
  const data = await verificationService.reject(req.user, req.params.id, req.body.reason);
  res.json({ success: true, data });
};

export const revoke = async (req, res) => {
  const data = await verificationService.revokeShop(req.user, req.params.shopId, req.body.reason);
  res.json({ success: true, data });
};

export const auditLogs = async (req, res) => {
  const { items, pagination } = await verificationService.listAuditLogs(req.validated);
  res.json({ success: true, data: items, meta: { pagination } });
};
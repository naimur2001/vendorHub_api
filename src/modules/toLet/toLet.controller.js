import * as s from './toLet.service.js';
import * as a from './toLet.admin.service.js';

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// ---------- owner ----------
export const create = async (req, res) => ok(res, await s.createToLet(req.user ?? null, req.body), 201);
export const confirmEmail = async (req, res) => ok(res, await s.confirmEmail(req.body.token));
export const mine = async (req, res) => ok(res, await s.listMine(req.user.id));
export const manage = async (req, res) => ok(res, await s.getManaged(req.validated.token));
export const update = async (req, res) => ok(res, await s.updateToLet(req, req.params.id, req.body));
export const withdraw = async (req, res) => ok(res, await s.withdraw(req, req.params.id));
export const addPhoto = async (req, res) => ok(res, await s.addPhoto(req, req.params.id, req.file), 201);
export const removePhoto = async (req, res) => {
  await s.removePhoto(req, req.params.id, req.params.photoId);
  res.status(204).end();
};
export const addDocument = async (req, res) => ok(res, await s.addDocument(req, req.params.id, req.file), 201);
export const ownerMessages = async (req, res) => ok(res, await s.ownerMessages(req, req.params.id));
export const ownerSend = async (req, res) => ok(res, await s.ownerSend(req, req.params.id, req.body.body), 201);

// ---------- public ----------
export const list = async (req, res) => {
  const { items, pagination } = await s.listPublic(req.validated);
  res.json({ success: true, data: items, meta: { pagination } });
};
export const get = async (req, res) => ok(res, await s.getPublic(req.params.slug));
export const inquire = async (req, res) => ok(res, await s.createInquiry(req.user ?? null, req.params.id, req.body), 201);
export const inquiryMessages = async (req, res) => ok(res, await s.inquiryMessages(req, req.params.id, req.validated.token));
export const inquirySend = async (req, res) => {
  const token = typeof req.query.token === 'string' && /^[a-f0-9]{64}$/.test(req.query.token) ? req.query.token : undefined;
  ok(res, await s.inquirySend(req, req.params.id, token, req.body.body), 201);
};

// ---------- admin ----------
export const adminList = async (req, res) => {
  const { items, counts, pagination } = await a.listAdmin(req.user, req.validated);
  res.json({ success: true, data: items, meta: { counts, pagination } });
};
export const adminGet = async (req, res) => ok(res, await a.getAdmin(req.user, req.params.id));
// Private documents: never cached, never run. PDFs (which can contain scripts) are downloaded, not opened.
export const adminDocument = async (req, res) => {
  const f = await a.getDocument(req.user, req.params.id, req.params.docId);
  const isPdf = f.mimeType === 'application/pdf';
  res.set({
    'Content-Disposition': isPdf ? 'attachment; filename="document.pdf"' : 'inline',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  res.type(f.mimeType);
  res.sendFile(f.fullPath);
};
export const publish = async (req, res) => ok(res, await a.publish(req.user, req.params.id));
export const requestInfo = async (req, res) => ok(res, await a.requestInfo(req.user, req.params.id, req.body.message));
export const reject = async (req, res) => ok(res, await a.reject(req.user, req.params.id, req.body.reason));
export const markRented = async (req, res) => ok(res, await a.markRented(req.user, req.params.id));
export const renew = async (req, res) => ok(res, await a.renew(req.user, req.params.id));
export const addNote = async (req, res) => ok(res, await a.addNote(req.user, req.params.id, req.body.body), 201);
export const replyOwner = async (req, res) => ok(res, await a.replyOwner(req.user, req.params.id, req.body.body), 201);
export const replyInquiry = async (req, res) => ok(res, await a.replyInquiry(req.user, req.params.id, req.body.body), 201);
export const inquiryStatus = async (req, res) => ok(res, await a.setInquiryStatus(req.user, req.params.id, req.body.status));
export const shareContacts = async (req, res) => ok(res, await a.shareContacts(req.user, req.params.id));

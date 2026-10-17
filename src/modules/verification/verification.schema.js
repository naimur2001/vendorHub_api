import { z } from 'zod';

const documentInput = z.object({
  type: z.enum(['TRADE_LICENSE', 'NID', 'SHOP_PHOTO', 'OTHER']),
  fileUrl: z.string().url().max(500),
});

export const submitVerificationSchema = z.object({
  targetLevel: z.enum(['DOCUMENTS_VERIFIED', 'BUSINESS_VERIFIED', 'PHYSICAL_SHOP_VERIFIED', 'TRUSTED_VENDOR']),
  documents: z.array(documentInput).min(1).max(10),
});

export const resubmitSchema = z.object({
  documents: z.array(documentInput).min(1).max(10),
});

export const reviewDocumentSchema = z.object({ reviewed: z.boolean() });

export const notesSchema = z.object({ notes: z.string().trim().max(2000) });

export const requestCorrectionSchema = z.object({
  note: z.string().trim().min(5).max(1000),
  documentIds: z.array(z.string().uuid()).min(1).max(10),
});

export const rejectSchema = z.object({ reason: z.string().trim().min(5).max(1000) });

export const revokeSchema = z.object({ reason: z.string().trim().min(5).max(1000) });

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
};

export const adminQuery = z.object({
  status: z
    .enum(['OPEN', 'ALL', 'PENDING', 'AUTO_FLAGGED', 'CORRECTION_REQUESTED', 'APPROVED', 'REJECTED', 'REVOKED'])
    .default('OPEN'), // OPEN = PENDING + AUTO_FLAGGED (waiting for an admin)
  q: z.string().trim().min(1).optional(), // shop name
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  ...pagination,
});

export const auditQuery = z.object({
  entityType: z.string().trim().min(1).optional(),
  entityId: z.string().trim().min(1).optional(),
  ...pagination,
});
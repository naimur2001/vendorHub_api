import { z } from 'zod';

const kinds = ['EXTERIOR', 'SIGNBOARD', 'INTERIOR', 'DISPLAY', 'PANORAMA_360', 'OTHER'];

export const addPhotoSchema = z.object({
  uploadId: z.string().uuid(), // the id returned by POST /uploads?purpose=PUBLIC_IMAGE
  kind: z.enum(kinds),
  caption: z.string().trim().max(200).optional(),
  isCover: z.boolean().optional(),
});

export const updatePhotoSchema = z
  .object({
    kind: z.enum(kinds).optional(),
    caption: z.string().trim().max(200).nullable().optional(),
    sortOrder: z.number().int().min(0).max(100).optional(),
    isCover: z.literal(true).optional(), // to change the cover, choose another photo as cover
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to update' });

export const verifyPhotoSchema = z.object({
  verified: z.boolean(),
});
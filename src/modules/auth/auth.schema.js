import { z } from 'zod';

export const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email(),
  phone: z
    .string()
    .trim()
    .regex(/^01\d{9}$/, 'Use a Bangladesh mobile number like 01712345678')
    .optional(),
  password: z.string().min(8).max(72), // bcrypt only uses the first 72 bytes
  role: z.enum(['CUSTOMER', 'SHOP_OWNER']).default('CUSTOMER'), // ADMIN can never self-register
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});


//new for change password
export const changePasswordSchema = z
  .object({
    oldPassword: z.string().min(1),
    newPassword: z.string().min(8).max(72),
  })
  .refine((d) => d.oldPassword !== d.newPassword, {
    message: 'New password must be different from the old one',
    path: ['newPassword'],
  });
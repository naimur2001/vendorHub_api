// Receives exactly ONE photo in a multipart field: max 5 MB, almost nothing else.
// Shared by every photo endpoint, so all of them follow the same rules.
import multer from 'multer';
import { AppError } from '../lib/errors.js';

const photo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5, fieldSize: 1024, parts: 6 },
});

export function receiveFileField(field) {
  return function receive(req, res, next) {
    photo.single(field)(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, 'The photo is larger than 5 MB'));
      if (err.name === 'MulterError') return next(new AppError(400, `Send exactly one photo in the multipart field "${field}"`));
      return next(err);
    });
  };
}

// markets, products, shop logo and banner
export const receivePhoto = receiveFileField('image');

// Home banners: "media" and an optional phone version "mobileMedia" (5 MB each), plus the text fields.
// A JSON request (no multipart) passes through untouched, so PATCH also works without files.
const bannerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 2, fields: 15, fieldSize: 1024, parts: 17 },
}).fields([
  { name: 'media', maxCount: 1 },
  { name: 'mobileMedia', maxCount: 1 },
]);

export function receiveBannerMedia(req, res, next) {
  bannerUpload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, 'The image is larger than 5 MB'));
    if (err.name === 'MulterError') {
      return next(new AppError(400, 'Send the banner image in "media" and an optional phone version in "mobileMedia"'));
    }
    return next(err);
  });
}
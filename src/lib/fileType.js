// Recognises a file by its first bytes ("magic bytes"), never by its name or the type the client claims.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: 'png', test: (b) => b.length >= 8 && b.subarray(0, 8).equals(PNG) },
  {
    mime: 'image/webp',
    ext: 'webp',
    test: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
  { mime: 'application/pdf', ext: 'pdf', test: (b) => b.length >= 5 && b.toString('ascii', 0, 5) === '%PDF-' },
];

// Returns { mime, ext } or null when the file is none of the known types.
export function detectFileType(buffer) {
  const found = SIGNATURES.find((s) => s.test(buffer));
  return found ? { mime: found.mime, ext: found.ext } : null;
}
# Vendors Hub API
Multi-vendor marketplace of verified physical shops in Bangladesh (backend only). Windows + PowerShell + VS Code.
Repo naimur2001/vendorHub_api, work branch `naimur`, releases on `main` (tags v1.x). Frontend is a separate repo.

## Stack
Node 22 (ES modules, plain JS), Express 5, Prisma 6, PostgreSQL 16 + pgvector (Docker image `pgvector/pgvector:0.8.0-pg16`, container `vendors-hub-db`, port 5433), Zod 4, JWT (+ httpOnly cookie mode via `X-Auth-Mode: cookie`), multer 2, sharp 0.35.5, @huggingface/transformers (CLIP, runs locally, model in `models-cache/`).

## Layout
- `src/modules/<name>/` -> `<name>.routes.js`, `.controller.js`, `.service.js`, `.schema.js` (Zod). Routers mounted at `/api/v1` in `src/app.js`.
- `src/lib/`: `images.js` (ONLY way to accept images: type from magic bytes + decoder, pixel limit, re-encode WebP, profiles), `storage.js` (stage/commit/remove files, `/media` URLs, `thumbFor`), `clip.js` + `fingerprints.js` (visual search), `mailer.js` (log | smtp), `notify.js`, `errors.js` (AppError(status, message, details)), `districts.js` (the 64 district keys + Zod `districtKey`; a market's `district`).
- `src/middlewares/`: `auth.js` (authenticate does one DB lookup: blocks ACCOUNT_DELETION_PENDING), `rateLimit.js`, `photoUpload.js` (receivePhoto / receiveFileField), `verifiedEmail.js`.
- Files: `uploads/media` (public WebP, served only by `/media/:name`), `uploads/private` (verification documents, originals, served by `GET /files/:id`), `uploads/staging`. Never served statically.
- Docs: `docs/openapi/base.yaml` + `docs/openapi/paths/NN-*.yaml`, merged in name order (a later file overrides a path method or schema). 146 operations. Swagger at `/api/docs`.

## Rules (important)
- Never edit an applied migration; always a new one (`npx prisma migrate dev --name ...`). Raw SQL needs `--create-only` then edit.
- New table -> add `prisma.<model>.deleteMany()` near the top of `clean()` in `prisma/seed.js`.
- Windows: STOP the dev server before `prisma migrate` / `prisma generate` (EPERM lock). Restart after `.env` or YAML changes.
- SQL only parameterised (`Prisma.sql`, `$queryRaw` templates). Never string-concatenate user input.
- Every image goes through `processImage` + `storage.js`; never store or serve original public image bytes.
- Errors: fixed messages, never echo user input; other users' data -> 404; admin decisions -> audit log; no personal data in logs.
- Never `npm audit fix --force` (it jumps to Prisma 7). Exact versions for new packages (`--save-exact`) + `npm audit`.
- New endpoint checklist: Zod schema, service, controller, route, OpenAPI file with `required`/`nullable`, update the exact count in `test-openapi.ps1`, PowerShell test, run the full suite.

## Tests
- PowerShell suites `test-*.ps1`, all run by `run-all-tests.ps1` (reseeds first; `test-security.ps1` must stay LAST). 32 suites, all must pass.
- Test `.env`: `MAIL_MODE=log`, `TRYON_MODE=mock`, `SEARCH_IMAGE_MODE=mock`, `AUTO_VERIFY_EMAIL_DOMAINS=vendorshub.test`. Never run tests in gemini/smtp mode.
- Scripts: ASCII only. PowerShell 5.1 quirks: wrap one-item results in `@()`; a WebRequestSession re-sends earlier headers; a hand-made `Cookie` header is dropped; curl joins repeated `--data-binary`.
- Helpers: `node --env-file=.env prisma/seed.js`, `scripts/backfill-fingerprints.mjs`, `scripts/check-openapi.mjs`, `scripts/clean-orphan-files.mjs` (dry run by default).

## Working style
Small steps. Read the relevant files before changing them. Ask before installing packages, running migrations or deleting data. After a change: run the affected test, then the full suite. Conventional commits (`feat(...)`, `fix(...)`, `chore(...)`), branch `naimur`. Short answers.
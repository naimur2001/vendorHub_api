# Vendors Hub API

Backend for a multi-vendor marketplace: products sold by real, verified physical shops. One canonical Product, many ShopListings (one per shop, own price and stock). Bargaining, split checkout (one independent order per shop), shop verification with an admin portal, dashboards.

Stack: Node 22, Express 5, Prisma 6, PostgreSQL 16, Zod, JWT, Docker. Plain JavaScript, ES modules. I develop on Windows (PowerShell). Deployment: Docker + Nginx on an Oracle Cloud Ubuntu VM (see docs in Notion).

## Run it
- Database: `docker compose up -d` (container `vendors-hub-db`, host port 5433, because 5432 was taken).
- Config: `.env` (never commit). DATABASE_URL uses port 5433. `src/config/env.js` validates every variable at startup.
- Server: `npm run dev` (node --watch --env-file=.env src/server.js), http://localhost:4000
- Migrations: `npx prisma migrate dev --name <name>` (development), `npx prisma migrate deploy` (servers). If `npx prisma` fails, run `npm install` and check `npx prisma -v`.
- Demo data: `node --env-file=.env prisma/seed.js`. It DELETES EVERYTHING first. Never run it against real data. All demo users use password `Password123!`: admin@, owner1@ (TechZone), owner2@ (staff at TechZone), owner3@ (Gadget Galaxy), customer@ (all @vendorshub.test).

## Tests
- PowerShell suites in the project root: test-cart, test-checkout, test-bargain, test-orders-reviews, test-verification, test-dashboards, test-catalog-admin, test-users-staff, test-security (.ps1). 419 checks in total, all passing.
- The server must be running. Run one with: `powershell -ExecutionPolicy Bypass -File .\test-cart.ps1`
- Run all (reseeds first): `powershell -ExecutionPolicy Bypass -File .\run-all-tests.ps1`. Keep rate limiting OFF (the development default).
- After every change, run the affected suite, and run-all-tests before a commit. Add a suite for every new module. Print the server's error message on failures (see existing scripts for the Call/Check/Login/Need helpers).
- Windows PowerShell 5.1 gotchas in scripts: `$pid` is a reserved variable; read error bodies from `$_.ErrorDetails.Message`; keep script files ASCII only.

## Structure
src/app.js (middleware order matters), src/server.js (sweeper, graceful shutdown), src/config/env.js, src/lib/ (prisma, jwt, errors, logger, shopAccess, availability, slug), src/middlewares/ (auth, validate, errorHandler, rateLimit), src/modules/<feature>/ with routes -> controller -> service -> schema. Modules: auth, catalog, shops, listings, cart, checkout, bargains, verification, fulfilment, reviews, dashboards, admin, adminCatalog, users, staff. 98 endpoints. The full endpoint list and code walkthrough are in Notion ("Vendors Hub API: Endpoint Reference", "Source Code") and in the Claude doc "Vendors Hub Backend: Code Walkthrough and Roadmap".

## Conventions (follow them)
- Responses: `{ success: true, data }`, lists add `meta.pagination`, errors `{ success: false, error: { message, details } }`. Services throw `AppError(status, message)`; only errorHandler builds error responses.
- Controllers contain no logic; services hold rules and Prisma calls; Zod schemas validate input (`validate` for body, `validateQuery` stores the result in `req.validated` because Express 5 req.query is read-only).
- Routers mounted at /api/v1 apply `authenticate` PER ROUTE, never `router.use(authenticate)` (it would turn unknown paths into 401).
- Authorization: `requireRole` for kinds of users, `assertShopAccess`
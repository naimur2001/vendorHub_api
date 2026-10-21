# Vendors Hub API

Backend for a multi-vendor marketplace where products are sold by real, verified physical shops: a hybrid catalog (one product, many shop listings), structured bargaining, split checkout (one independent order per shop), and shop verification with an admin portal and audit log.

**Stack:** Node.js 22, Express 5, Prisma 6, PostgreSQL 16, Zod, JWT, Docker.

## Run it locally (Windows PowerShell)

1. Install Node 22, Git and Docker Desktop.
2. `npm install`
3. Copy `.env.example` to `.env` and fill it in (`JWT_ACCESS_SECRET` needs 32+ random characters).
4. `docker compose up -d` (PostgreSQL on port 5433)
5. `npx prisma migrate deploy`
6. `npx prisma db seed` (demo data; the password of every demo user is `Password123!`)
7. `npm run dev` (http://localhost:4000)

Demo accounts (all `@vendorshub.test`): `admin`, `owner1` (TechZone), `owner2` (staff at TechZone), `owner3` (Gadget Galaxy), `customer`.

## Tests

With the server running:

```powershell
powershell -ExecutionPolicy Bypass -File .\run-all-tests.ps1
```

This resets the demo data and runs every suite.

## Structure

- `src/modules/<feature>/` holds routes, controller, service and schema for each feature (auth, catalog, shops, listings, cart, checkout, bargains, verification, fulfilment, reviews).
- `src/lib`, `src/middlewares`, `src/config` hold shared code.
- `prisma/` holds the schema, migrations and the seed.

## API and deployment documentation

The endpoint reference, the source code walkthrough, and the deployment runbook (Docker, Nginx, HTTPS, backups) are in the project's Notion workspace.
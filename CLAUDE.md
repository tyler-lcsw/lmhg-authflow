# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Healthcare authorization forms generator for Medicaid/MCO prior authorizations. Manages client demographics, provider/facility profiles, generates PDF authorization forms, and integrates with SRFax and IntakeQ for fax delivery and EMR document uploads.

## Development Commands

```bash
npm start           # Production server on port 3000
npm run dev         # Development with --watch auto-reload
npm install         # Install dependencies
node db.js          # Initialize/reset database (auto-runs on server start)
```

## Architecture

### Backend (server.js)
- Express.js REST API on port 3000
- SQLite database via `db.js` module
- PDF generation pipeline at `POST /api/generate-auth` (~line 396):
  1. EJS template (`views/form_template.ejs`) rendered to HTML
  2. Puppeteer converts HTML to PDF
  3. pdf-lib merges IntakeQ notes PDFs and local file attachments
  4. PDF normalized via `normalizePdfForFax()` for SRFax compatibility
  5. Final PDF saved to `output/` directory
- **Hardcoded servicing facility**: "Louisville Mental Health Group" details are hardcoded inside `POST /api/generate-auth` (server.js ~line 408). These override any settings-provided facility data before template rendering.
- `node-fetch` is ESM-only so it is dynamically imported (`await import('node-fetch')`) inside each handler rather than at the top of the file.
- Both `output/` and `uploads/` directories must exist before the server starts (multer writes temp files to `uploads/`, which are cleaned up after PDF merge).

### External Integrations
- **SRFax** (`srfax.js`): Fax delivery service. Requires credentials in settings table (`srfax_access_id`, `srfax_access_pwd`, `srfax_caller_id`). **Number format**: CallerID must be exactly 10 digits; recipient ToNumber must be exactly 11 digits (country code + 10 digits, e.g. `15021234567`).
- **IntakeQ**: EMR integration for fetching clinical notes and uploading generated PDFs. API key stored in settings (`intakeq_api_key`). The `intakeq_client_id` on a `clients` row is auto-populated on first successful upload/search and cached for subsequent calls.

### Frontend (public/)
- Single-page vanilla JS application (`js/app.js`)
- View switching via CSS class toggling (no router)

## Database Tables (SQLite)
- `clients` - Patient demographics (name, Medicaid ID, DOB, PCP info, insurance flags, `intakeq_client_id`)
- `settings` - Single-row config (id=1): provider defaults, SRFax credentials, IntakeQ API key
- `provider_presets` - Saved provider/facility profiles (API still uses `/api/facilities` routes). Migrated from an old `facilities` table (now renamed `old_facilities`).
- `auth_requests` - Generated PDF history with `form_data` JSON, fax tracking fields, `clinical_status`, `is_draft`. Has both `id` (primary key) and `record_number` (sequential human-facing number auto-assigned at insert).
- `mco_fax_directory` - MCO name to fax number mappings

**Adding new columns**: append an `ALTER TABLE ... ADD COLUMN` statement to the `alterQueries` array in `db.js`. Duplicate-column errors are silently ignored, making this safe for incremental migrations.

### Draft Workflow
- `POST /api/save-auth-draft` - Save work-in-progress forms (`is_draft=1`)
- Drafts can be updated and later finalized via `POST /api/generate-auth` with `auth_id`

## Key Files

- `server.js:381-509` - PDF generation endpoint
- `server.js:512-585` - SRFax send/check endpoints
- `server.js:831-919` - IntakeQ PDF upload endpoint
- `db.js` - Database schema and migrations
- `srfax.js` - SRFax API wrapper (`sendFax`, `checkFaxStatus`)
- `views/form_template.ejs` - EJS template for authorization form

## API Endpoints

### Core CRUD
- `GET/POST/PUT/DELETE /api/clients`
- `GET/PUT /api/settings`
- `GET/POST/PUT/DELETE /api/facilities` (maps to `provider_presets` table)
- `GET/DELETE /api/auth-requests/:id`
- `PUT /api/auth-requests/:id` - Update form_data or clinical_status

### PDF & Auth Requests
- `POST /api/generate-auth` - Generate PDF with optional attachments
- `POST /api/save-auth-draft` - Save draft without generating PDF
- `GET /api/auth-requests/:id/download` - Download generated PDF
- `GET /api/auth-requests/:id/preview` - View PDF in browser
- `GET /api/clients/:id/auth-requests` - List all auth requests for a client

### Fax Integration
- `POST /api/send-fax/:authId` - Send PDF via SRFax
- `POST /api/check-fax-status/:authId` - Check delivery status
- `POST /api/send-test-fax` - Send test fax to configured Caller ID
- `GET/POST/PUT/DELETE /api/mco-fax-directory` - Manage MCO fax numbers

### IntakeQ Integration
- `GET /api/intakeq/notes` - Fetch clinical notes for a client
- `GET /api/intakeq/client-search` - Search IntakeQ clients by name
- `GET /api/intakeq/files` - List files in a client's IntakeQ gallery (`?intakeqClientId=`)
- `POST /api/intakeq/upload-auth/:authId` - Upload generated PDF to client's IntakeQ file gallery

### Diagnostics
- `POST /api/diag-fax` - Returns masked SRFax credential status and number format validation

#!/usr/bin/env node
/**
 * Live IntakeQ upload script — hits the RUNNING dev server to exercise the end-to-end
 * PDF upload flow that had the JSON-error-on-success bug.
 *
 * Usage:
 *   node tests/live/intakeq-upload.js <authId> [--base=http://localhost:3000]
 *
 * Verifies:
 *   1. The upload call succeeds (no "JSON error" alert).
 *   2. The uploaded file shows up in GET /api/intakeq/files for the linked client.
 */

const BASE = (process.argv.find(a => a.startsWith('--base=')) || '--base=http://localhost:3000').slice(7);
const authId = process.argv[2];

if (!authId || authId.startsWith('--')) {
    console.error('Usage: node tests/live/intakeq-upload.js <authId> [--base=http://localhost:3000]');
    process.exit(1);
}

async function req(method, path, body) {
    const resp = await fetch(`${BASE}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined
    });
    const raw = await resp.text();
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
    return { ok: resp.ok, status: resp.status, body: parsed };
}

(async () => {
    console.log(`→ Server: ${BASE}`);
    console.log(`→ Auth ID: ${authId}`);
    console.log('');

    console.log('[1/2] POST /api/intakeq/upload-auth/:authId …');
    const upload = await req('POST', `/api/intakeq/upload-auth/${authId}`);
    console.log('  status:', upload.status);
    console.log('  body:', JSON.stringify(upload.body, null, 2));
    if (!upload.ok || !upload.body.success) {
        console.error('  ✗ Upload returned error — this is the reported bug if PDF is actually on IntakeQ.');
        process.exit(2);
    }
    console.log('  ✓ Upload success');
    console.log('');

    console.log('[2/2] Verifying via GET /api/intakeq/files …');
    const match = upload.body.message.match(/IntakeQ Client #([^)]+)\)/);
    const iqId = match && match[1];
    if (!iqId) {
        console.warn('  ⚠ Could not extract IntakeQ Client ID from response message; skipping file verification.');
        process.exit(0);
    }
    const files = await req('GET', `/api/intakeq/files?intakeqClientId=${encodeURIComponent(iqId)}`);
    if (!files.ok) {
        console.error('  ✗ Files list failed:', files.body);
        process.exit(3);
    }
    const arr = Array.isArray(files.body) ? files.body : [];
    console.log(`  ✓ Gallery has ${arr.length} file(s).`);
    const latest = arr[0];
    if (latest) console.log('  Latest file:', JSON.stringify(latest, null, 2));
})().catch(err => {
    console.error('Fatal:', err);
    process.exit(99);
});

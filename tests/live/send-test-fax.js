#!/usr/bin/env node
/**
 * Live SRFax test fax script — hits the RUNNING dev server (default http://localhost:3000)
 * to queue a real test fax, then polls the status until it reaches a terminal state.
 *
 * Usage:
 *   node tests/live/send-test-fax.js [toFax] [--base=http://localhost:3000]
 *
 * Default destination: 8889771527 (facility fax). Sends a 1-page PDF.
 */

const BASE = (process.argv.find(a => a.startsWith('--base=')) || '--base=http://localhost:3000').slice(7);
const toFax = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '8889771527';

async function post(path, body) {
    const resp = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    });
    const raw = await resp.text();
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
    return { ok: resp.ok, status: resp.status, body: parsed };
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
    console.log(`→ Server: ${BASE}`);
    console.log(`→ Destination: ${toFax}`);
    console.log('');

    console.log('[1/3] Checking credentials via /api/diag-fax …');
    const diag = await post('/api/diag-fax');
    if (!diag.ok || !diag.body.all_valid) {
        console.error('  ✗ Credentials not valid:', diag.body);
        process.exit(1);
    }
    console.log('  ✓', JSON.stringify(diag.body));
    console.log('');

    console.log('[2/3] Sending test fax …');
    const send = await post('/api/send-test-fax', { toFax });
    if (!send.ok || !send.body.success) {
        console.error('  ✗ Send failed:', send.body);
        process.exit(2);
    }
    const faxDetailsId = send.body.faxDetailsId;
    console.log(`  ✓ Queued. faxDetailsId=${faxDetailsId}  toFax=${send.body.toFax}`);
    console.log('');

    console.log('[3/3] Polling status every 10s (up to 2 min) …');
    const deadline = Date.now() + 120000;
    let lastStatus = '';
    while (Date.now() < deadline) {
        const st = await post('/api/fax-status', { faxDetailsId });
        const status = (st.body && st.body.faxStatus) || 'Unknown';
        if (status !== lastStatus) {
            console.log(`  [${new Date().toISOString().slice(11,19)}] status=${status}`);
            lastStatus = status;
        }
        if (status && !['In Progress', 'Queued', 'Unknown'].includes(status)) {
            console.log('');
            console.log(`✓ Terminal status reached: ${status}`);
            console.log('Full details:', JSON.stringify(st.body.details, null, 2));
            process.exit(status === 'Sent' ? 0 : 3);
        }
        await sleep(10000);
    }

    console.error('\n⚠ Timed out after 2 min. Last status:', lastStatus);
    process.exit(4);
})().catch(err => {
    console.error('Fatal:', err);
    process.exit(99);
});

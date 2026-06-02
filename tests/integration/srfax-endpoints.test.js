const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
    startTestServer,
    seedSettings,
    insertClient,
    insertAuthRequest,
    callJson
} = require('../helpers/testServer');

const VALID_CREDS = {
    srfax_access_id: 'TEST_AID',
    srfax_access_pwd: 'TEST_PWD',
    srfax_caller_id: '5025550100',
    srfax_sender_email: 'test@example.com'
};

// ===== /api/diag-fax =====

test('POST /api/diag-fax reports all_valid when credentials are complete', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, VALID_CREDS);
        const r = await callJson(srv.baseUrl, '/api/diag-fax', { method: 'POST' });
        assert.equal(r.status, 200);
        assert.equal(r.body.all_valid, true);
        assert.equal(r.body.caller_id_cleaned, '5025550100');
        assert.equal(r.body.caller_id_length, 10);
        assert.equal(r.body.to_fax_would_be, '15025550100');
        assert.equal(r.body.to_fax_length, 11);
        assert.equal(r.body.access_id, 'TEST****'); // masked
        assert.equal(r.body.access_pwd, '****');
    } finally {
        await srv.close();
    }
});

test('POST /api/diag-fax reports all_valid=false when creds are missing', async () => {
    const srv = await startTestServer();
    try {
        const r = await callJson(srv.baseUrl, '/api/diag-fax', { method: 'POST' });
        assert.equal(r.status, 200);
        assert.equal(r.body.all_valid, false);
        assert.equal(r.body.access_id, 'NOT SET');
    } finally {
        await srv.close();
    }
});

// ===== /api/send-test-fax =====

test('POST /api/send-test-fax (no body) loops back to caller ID', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, VALID_CREDS);

        const srfax = require('../../srfax');
        const calls = [];
        srfax.__setPoster(async (p) => { calls.push(p); return { Status: 'Success', Result: 'FAX_1' }; });

        const r = await callJson(srv.baseUrl, '/api/send-test-fax', { method: 'POST' });
        srfax.__resetPoster();

        assert.equal(r.status, 200);
        assert.equal(r.body.success, true);
        assert.equal(r.body.faxDetailsId, 'FAX_1');
        assert.equal(r.body.toFax, '15025550100');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].sToFaxNumber, '15025550100');
        assert.equal(calls[0].sCallerID, '5025550100');
    } finally {
        await srv.close();
    }
});

test('POST /api/send-test-fax with {toFax:"5025550101"} sends to 15025550101', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, VALID_CREDS);

        const srfax = require('../../srfax');
        const calls = [];
        srfax.__setPoster(async (p) => { calls.push(p); return { Status: 'Success', Result: 'FAX_2' }; });

        const r = await callJson(srv.baseUrl, '/api/send-test-fax', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ toFax: '5025550101' })
        });
        srfax.__resetPoster();

        assert.equal(r.status, 200);
        assert.equal(r.body.toFax, '15025550101');
        assert.equal(calls[0].sToFaxNumber, '15025550101');
    } finally {
        await srv.close();
    }
});

test('POST /api/send-test-fax with invalid toFax returns 400', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, VALID_CREDS);

        const srfax = require('../../srfax');
        srfax.__setPoster(async () => ({ Status: 'Success', Result: 'unused' }));

        const r = await callJson(srv.baseUrl, '/api/send-test-fax', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ toFax: '123' })
        });
        srfax.__resetPoster();

        assert.equal(r.status, 400);
        assert.match(r.body.error, /Invalid test destination/);
    } finally {
        await srv.close();
    }
});

test('POST /api/send-test-fax returns 400 when SRFax responds with error status', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, VALID_CREDS);

        const srfax = require('../../srfax');
        srfax.__setPoster(async () => ({ Status: 'Failed', Result: 'Invalid credentials' }));

        const r = await callJson(srv.baseUrl, '/api/send-test-fax', { method: 'POST' });
        srfax.__resetPoster();

        assert.equal(r.status, 400);
        assert.match(r.body.error, /SRFax error: Invalid credentials/);
    } finally {
        await srv.close();
    }
});

test('POST /api/send-test-fax returns 400 when credentials missing', async () => {
    const srv = await startTestServer();
    try {
        // no seeding
        const r = await callJson(srv.baseUrl, '/api/send-test-fax', { method: 'POST' });
        assert.equal(r.status, 400);
        assert.match(r.body.error, /not configured/);
    } finally {
        await srv.close();
    }
});

// ===== /api/send-fax/:authId =====

async function seedAuthRequestWithPdf(srv) {
    const pdfPath = path.join(srv.tmpDir, 'test-auth.pdf');
    // minimal valid-ish PDF content — not a real PDF but enough for fs.existsSync + readFileSync
    // normalizePdfForFax will try to parse via pdf-lib though — use a tiny real PDF
    const minimalPdf = await makeMinimalPdf();
    fs.writeFileSync(pdfPath, minimalPdf);
    const clientId = await insertClient(srv.db, { name: 'Test Patient' });
    const authId = await insertAuthRequest(srv.db, { client_id: clientId, pdf_path: pdfPath });
    return { authId, pdfPath };
}

async function makeMinimalPdf() {
    const { PDFDocument } = require('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    return Buffer.from(await doc.save());
}

test('POST /api/send-fax/:authId queues a fax and stores fax_details_id', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, VALID_CREDS);
        const { authId } = await seedAuthRequestWithPdf(srv);

        const srfax = require('../../srfax');
        const calls = [];
        srfax.__setPoster(async (p) => { calls.push(p); return { Status: 'Success', Result: 'FAX_SEND_ID' }; });

        const r = await callJson(srv.baseUrl, `/api/send-fax/${authId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ toFaxNumber: '15025550101' })
        });
        srfax.__resetPoster();

        assert.equal(r.status, 200);
        assert.equal(r.body.success, true);
        assert.equal(r.body.faxDetailsId, 'FAX_SEND_ID');
        assert.equal(calls[0].sToFaxNumber, '15025550101');

        // Confirm DB was updated
        const { selectOne } = require('../helpers/testServer');
        const row = await selectOne(srv.db, 'SELECT fax_details_id, fax_status, fax_to_number FROM auth_requests WHERE id = ?', [authId]);
        assert.equal(row.fax_details_id, 'FAX_SEND_ID');
        assert.equal(row.fax_status, 'In Progress');
        assert.equal(row.fax_to_number, '1 (502) 555-0101');
    } finally {
        await srv.close();
    }
});

test('POST /api/send-fax/:authId returns 404 when PDF is missing', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, VALID_CREDS);
        const clientId = await insertClient(srv.db, { name: 'No PDF' });
        const authId = await insertAuthRequest(srv.db, { client_id: clientId, pdf_path: '/nonexistent/path.pdf' });

        const srfax = require('../../srfax');
        srfax.__setPoster(async () => ({ Status: 'Success', Result: 'unused' }));

        const r = await callJson(srv.baseUrl, `/api/send-fax/${authId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ toFaxNumber: '15025550101' })
        });
        srfax.__resetPoster();

        assert.equal(r.status, 404);
        assert.match(r.body.error, /PDF not found/);
    } finally {
        await srv.close();
    }
});

test('POST /api/send-fax/:authId returns 400 when toFaxNumber is missing', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, VALID_CREDS);
        const r = await callJson(srv.baseUrl, '/api/send-fax/1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        assert.equal(r.status, 400);
        assert.match(r.body.error, /Recipient fax number is required/);
    } finally {
        await srv.close();
    }
});

// ===== /api/fax-status =====

test('POST /api/fax-status returns current status via SRFax', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, VALID_CREDS);
        const clientId = await insertClient(srv.db, { name: 'Fax Status Owner' });
        await insertAuthRequest(srv.db, {
            client_id: clientId,
            fax_details_id: 'FAX_X',
            fax_status: 'In Progress'
        });

        const srfax = require('../../srfax');
        srfax.__setPoster(async () => ({ Status: 'Success', Result: { SentStatus: 'Sent', Pages: 1 } }));

        const r = await callJson(srv.baseUrl, '/api/fax-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ faxDetailsId: 'FAX_X' })
        });
        srfax.__resetPoster();

        assert.equal(r.status, 200);
        assert.equal(r.body.faxStatus, 'Sent');
        assert.equal(r.body.details.Pages, 1);
    } finally {
        await srv.close();
    }
});

test('POST /api/fax-status rejects faxDetailsId values not linked to local auth requests', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, VALID_CREDS);

        const srfax = require('../../srfax');
        let calls = 0;
        srfax.__setPoster(async () => {
            calls += 1;
            return { Status: 'Success', Result: { SentStatus: 'Sent' } };
        });

        const r = await callJson(srv.baseUrl, '/api/fax-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ faxDetailsId: 'FOREIGN_FAX' })
        });
        srfax.__resetPoster();

        assert.equal(r.status, 404);
        assert.match(r.body.error, /not found|not linked/i);
        assert.equal(calls, 0);
    } finally {
        await srv.close();
    }
});

test('POST /api/check-fax-status/:authId skips SRFax when local status is terminal', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, VALID_CREDS);
        const clientId = await insertClient(srv.db, { name: 'Already Sent' });
        const authId = await insertAuthRequest(srv.db, {
            client_id: clientId,
            fax_details_id: 'FAX_DONE',
            fax_status: 'Sent'
        });

        const srfax = require('../../srfax');
        let calls = 0;
        srfax.__setPoster(async () => {
            calls += 1;
            return { Status: 'Success', Result: { SentStatus: 'In Progress' } };
        });

        const r = await callJson(srv.baseUrl, `/api/check-fax-status/${authId}`, { method: 'POST' });
        srfax.__resetPoster();

        assert.equal(r.status, 200);
        assert.equal(r.body.faxStatus, 'Sent');
        assert.equal(r.body.skipped, true);
        assert.equal(calls, 0);
    } finally {
        await srv.close();
    }
});

test('POST /api/fax-status returns 400 without faxDetailsId', async () => {
    const srv = await startTestServer();
    try {
        const r = await callJson(srv.baseUrl, '/api/fax-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        assert.equal(r.status, 400);
    } finally {
        await srv.close();
    }
});

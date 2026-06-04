const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
    startTestServer,
    seedSettings,
    insertClient,
    insertAuthRequest,
    selectOne,
    callJson
} = require('../helpers/testServer');

function fakeFetchFactory(routes) {
    // routes: array of { match: (url, init) => bool, respond: (url, init) => {ok,status,text} }
    const calls = [];
    const fn = async (url, init = {}) => {
        calls.push({ url, init });
        for (const r of routes) {
            if (r.match(url, init)) {
                const resp = await r.respond(url, init);
                return {
                    ok: resp.ok !== false && (resp.status || 200) < 400,
                    status: resp.status || 200,
                    text: async () => resp.body || ''
                };
            }
        }
        throw new Error(`No route for ${init.method || 'GET'} ${url}`);
    };
    fn.calls = calls;
    return fn;
}

async function seedClientAndAuth(srv, { name = 'Jane Doe', intakeq_client_id = null } = {}) {
    const clientId = await insertClient(srv.db, { name, intakeq_client_id });
    const pdfPath = path.join(srv.tmpDir, `auth-${clientId}.pdf`);
    fs.writeFileSync(pdfPath, '%PDF-fake');
    const authId = await insertAuthRequest(srv.db, { client_id: clientId, pdf_path: pdfPath });
    return { clientId, authId };
}

// ============ The reported bug: empty/non-JSON 200 body on upload ============

test('POST /api/intakeq/upload-auth/:authId with EMPTY 200 body returns success (regression for JSON error bug)', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });
        const { authId } = await seedClientAndAuth(srv, { intakeq_client_id: 'IQ_42' });

        const intakeq = require('../../intakeq');
        intakeq.__setFetch(fakeFetchFactory([
            { match: url => /\/files\/IQ_42$/.test(url), respond: () => ({ body: '' }) }
        ]));

        const r = await callJson(srv.baseUrl, `/api/intakeq/upload-auth/${authId}`, { method: 'POST' });
        intakeq.__reset();

        assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.success, true);
        assert.deepEqual(r.body.file, {});
    } finally {
        await srv.close();
    }
});

test('POST /api/intakeq/upload-auth/:authId with NON-JSON 200 body returns success with raw (regression)', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });
        const { authId } = await seedClientAndAuth(srv, { intakeq_client_id: 'IQ_42' });

        const intakeq = require('../../intakeq');
        intakeq.__setFetch(fakeFetchFactory([
            { match: url => /\/files\/IQ_42$/.test(url), respond: () => ({ body: 'FILE_ID_99' }) }
        ]));

        const r = await callJson(srv.baseUrl, `/api/intakeq/upload-auth/${authId}`, { method: 'POST' });
        intakeq.__reset();

        assert.equal(r.status, 200);
        assert.equal(r.body.success, true);
        assert.deepEqual(r.body.file, { raw: 'FILE_ID_99' });
    } finally {
        await srv.close();
    }
});

test('POST /api/intakeq/upload-auth/:authId with valid JSON body passes it through', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });
        const { authId } = await seedClientAndAuth(srv, { intakeq_client_id: 'IQ_42' });

        const intakeq = require('../../intakeq');
        intakeq.__setFetch(fakeFetchFactory([
            { match: url => /\/files\/IQ_42$/.test(url), respond: () => ({ body: '{"Id":"F1","Name":"test.pdf"}' }) }
        ]));

        const r = await callJson(srv.baseUrl, `/api/intakeq/upload-auth/${authId}`, { method: 'POST' });
        intakeq.__reset();

        assert.equal(r.status, 200);
        assert.equal(r.body.success, true);
        assert.deepEqual(r.body.file, { Id: 'F1', Name: 'test.pdf' });

        const row = await selectOne(srv.db, 'SELECT intakeq_uploaded_at FROM auth_requests WHERE id = ?', [authId]);
        assert.ok(row.intakeq_uploaded_at);
    } finally {
        await srv.close();
    }
});

test('POST /api/intakeq/upload-auth/:authId returns 500 when IntakeQ returns 4xx', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });
        const { authId } = await seedClientAndAuth(srv, { intakeq_client_id: 'IQ_42' });

        const intakeq = require('../../intakeq');
        intakeq.__setFetch(fakeFetchFactory([
            { match: url => /\/files\/IQ_42$/.test(url), respond: () => ({ ok: false, status: 413, body: 'payload too large' }) }
        ]));

        const r = await callJson(srv.baseUrl, `/api/intakeq/upload-auth/${authId}`, { method: 'POST' });
        intakeq.__reset();

        assert.equal(r.status, 500);
        assert.match(r.body.error, /IntakeQ upload failed: 413/);
    } finally {
        await srv.close();
    }
});

// ============ Upload requires explicit IntakeQ link ============

test('POST /api/intakeq/upload-auth/:authId refuses to auto-link the first name-search result', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });
        const { clientId, authId } = await seedClientAndAuth(srv, { name: 'New Patient' });

        const intakeq = require('../../intakeq');
        const fetchMock = fakeFetchFactory([
            {
                match: url => /\/clients\?search=/.test(url),
                respond: () => ({ body: '[{"ClientId":"IQ_CLIENT_123","Name":"New Patient"}]' })
            },
            {
                match: url => /\/files\/IQ_CLIENT_123$/.test(url),
                respond: () => ({ body: '{"Id":"UP_1"}' })
            }
        ]);
        intakeq.__setFetch(fetchMock);

        const r = await callJson(srv.baseUrl, `/api/intakeq/upload-auth/${authId}`, { method: 'POST' });
        intakeq.__reset();

        assert.equal(r.status, 409);
        assert.match(r.body.error, /Sync from IntakeQ|linked/i);
        const row = await selectOne(srv.db, 'SELECT intakeq_client_id FROM clients WHERE id = ?', [clientId]);
        assert.equal(row.intakeq_client_id, null);
        assert.equal(fetchMock.calls.length, 0);
    } finally {
        await srv.close();
    }
});

test('POST /api/intakeq/upload-auth/:authId skips search when intakeq_client_id already stored', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });
        const { authId } = await seedClientAndAuth(srv, { intakeq_client_id: 'PREEXISTING_ID' });

        const intakeq = require('../../intakeq');
        const fetchMock = fakeFetchFactory([
            { match: url => /\/files\/PREEXISTING_ID$/.test(url), respond: () => ({ body: '{"Id":"UP_99"}' }) }
        ]);
        intakeq.__setFetch(fetchMock);

        const r = await callJson(srv.baseUrl, `/api/intakeq/upload-auth/${authId}`, { method: 'POST' });
        intakeq.__reset();

        assert.equal(r.status, 200);
        assert.equal(fetchMock.calls.length, 1, 'only the upload call should have been made');
    } finally {
        await srv.close();
    }
});

test('POST /api/intakeq/upload-auth/:authId does not search IntakeQ when client is unlinked', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });
        const { authId } = await seedClientAndAuth(srv, { name: 'Unknown Patient' });

        const intakeq = require('../../intakeq');
        const fetchMock = fakeFetchFactory([
            { match: url => /\/clients\?search=/.test(url), respond: () => ({ body: '[]' }) }
        ]);
        intakeq.__setFetch(fetchMock);

        const r = await callJson(srv.baseUrl, `/api/intakeq/upload-auth/${authId}`, { method: 'POST' });
        intakeq.__reset();

        assert.equal(r.status, 409);
        assert.match(r.body.error, /Sync from IntakeQ|linked/i);
        assert.equal(fetchMock.calls.length, 0);
    } finally {
        await srv.close();
    }
});

test('POST /api/generate-auth rejects IntakeQ attachments when client is not linked', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });
        const clientId = await insertClient(srv.db, { name: 'No Link' });

        const form = new FormData();
        form.append('formData', JSON.stringify({ client_id: clientId, date: '2026-05-21' }));
        form.append('intakeqNotes', JSON.stringify(['NOTE_FOREIGN']));

        const resp = await fetch(`${srv.baseUrl}/api/generate-auth`, { method: 'POST', body: form });
        const body = await resp.json();

        assert.equal(resp.status, 400);
        assert.match(body.error, /IntakeQ client/i);
    } finally {
        await srv.close();
    }
});

test('POST /api/generate-auth rejects IntakeQ notes not returned for the linked client', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });
        const clientId = await insertClient(srv.db, { name: 'Linked', intakeq_client_id: 'IQ_7' });

        const intakeq = require('../../intakeq');
        intakeq.__setFetch(fakeFetchFactory([
            { match: url => /\/notes\/summary\?clientId=IQ_7/.test(url), respond: () => ({ body: '[{"Id":"NOTE_ALLOWED"}]' }) }
        ]));

        const form = new FormData();
        form.append('formData', JSON.stringify({ client_id: clientId, date: '2026-05-21' }));
        form.append('intakeqNotes', JSON.stringify(['NOTE_FOREIGN']));

        const resp = await fetch(`${srv.baseUrl}/api/generate-auth`, { method: 'POST', body: form });
        const body = await resp.json();
        intakeq.__reset();

        assert.equal(resp.status, 400);
        assert.match(body.error, /not linked to this client/i);
    } finally {
        await srv.close();
    }
});

test('POST /api/generate-auth rejects IntakeQ files not returned for the linked client', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });
        const clientId = await insertClient(srv.db, { name: 'Linked Files', intakeq_client_id: 'IQ_8' });

        const intakeq = require('../../intakeq');
        intakeq.__setFetch(fakeFetchFactory([
            { match: url => /\/files\?clientId=IQ_8/.test(url), respond: () => ({ body: '[{"Id":"FILE_ALLOWED"}]' }) }
        ]));

        const form = new FormData();
        form.append('formData', JSON.stringify({ client_id: clientId, date: '2026-05-21' }));
        form.append('intakeqFiles', JSON.stringify(['FILE_FOREIGN']));

        const resp = await fetch(`${srv.baseUrl}/api/generate-auth`, { method: 'POST', body: form });
        const body = await resp.json();
        intakeq.__reset();

        assert.equal(resp.status, 400);
        assert.match(body.error, /not linked to this client/i);
    } finally {
        await srv.close();
    }
});

test('POST /api/generate-auth rejects traversal client_id before generating a PDF', async () => {
    const srv = await startTestServer();
    try {
        const form = new FormData();
        form.append('formData', JSON.stringify({
            client_id: '../../../../../../../tmp/auth_forms_probe',
            date: '2026-06-04'
        }));

        const resp = await fetch(`${srv.baseUrl}/api/generate-auth`, { method: 'POST', body: form });
        const body = await resp.json();

        assert.equal(resp.status, 400);
        assert.match(body.error, /invalid filename characters/i);
    } finally {
        await srv.close();
    }
});

// ============ 400s / misconfigurations ============

test('POST /api/intakeq/upload-auth/:authId returns 400 when API key is not configured', async () => {
    const srv = await startTestServer();
    try {
        const { authId } = await seedClientAndAuth(srv, { intakeq_client_id: 'IQ' });
        const r = await callJson(srv.baseUrl, `/api/intakeq/upload-auth/${authId}`, { method: 'POST' });
        assert.equal(r.status, 400);
        assert.match(r.body.error, /IntakeQ API Key not configured/);
    } finally {
        await srv.close();
    }
});

test('POST /api/intakeq/upload-auth/:authId returns 404 when PDF file missing on disk', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });
        const clientId = await insertClient(srv.db, { name: 'Jane', intakeq_client_id: 'IQ' });
        const authId = await insertAuthRequest(srv.db, { client_id: clientId, pdf_path: '/not/real.pdf' });
        const r = await callJson(srv.baseUrl, `/api/intakeq/upload-auth/${authId}`, { method: 'POST' });
        assert.equal(r.status, 404);
        assert.match(r.body.error, /PDF not found/);
    } finally {
        await srv.close();
    }
});

// ============ Other IntakeQ endpoints (smoke) ============

test('GET /api/intakeq/client-search proxies results', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });

        const intakeq = require('../../intakeq');
        intakeq.__setFetch(fakeFetchFactory([
            { match: url => /\/clients\?search=Jane%20Doe/.test(url), respond: () => ({ body: '[{"ClientId":"1"}]' }) }
        ]));

        const r = await callJson(srv.baseUrl, '/api/intakeq/client-search?name=Jane%20Doe');
        intakeq.__reset();

        assert.equal(r.status, 200);
        assert.deepEqual(r.body, [{ ClientId: '1' }]);
    } finally {
        await srv.close();
    }
});

test('GET /api/intakeq/client-search returns upstream failure details', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });

        const intakeq = require('../../intakeq');
        intakeq.__setFetch(fakeFetchFactory([
            { match: url => /\/clients\?search=Jane%20Doe/.test(url), respond: () => ({ ok: false, status: 401, body: 'bad key' }) }
        ]));

        const r = await callJson(srv.baseUrl, '/api/intakeq/client-search?name=Jane%20Doe');
        intakeq.__reset();

        assert.equal(r.status, 502);
        assert.equal(r.body.error, 'IntakeQ client search failed');
        assert.equal(r.body.upstreamStatus, 401);
        assert.match(r.body.detail, /bad key/);
        assert.ok(r.body.traceId);
    } finally {
        await srv.close();
    }
});

test('GET /api/intakeq/files returns list for a linked local client', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });
        const clientId = await insertClient(srv.db, { name: 'Linked Files', intakeq_client_id: 'IQ_5' });

        const intakeq = require('../../intakeq');
        intakeq.__setFetch(fakeFetchFactory([
            { match: url => /\/files\?clientId=IQ_5/.test(url), respond: () => ({ body: '[{"Id":"a"}]' }) }
        ]));

        const r = await callJson(srv.baseUrl, `/api/intakeq/files?clientId=${clientId}&intakeqClientId=IQ_5`);
        intakeq.__reset();

        assert.equal(r.status, 200);
        assert.deepEqual(r.body, [{ Id: 'a' }]);
    } finally {
        await srv.close();
    }
});

test('GET /api/intakeq/files rejects IntakeQ IDs without a local client context', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });
        await insertClient(srv.db, { name: 'Other Client', intakeq_client_id: 'IQ_FOREIGN' });

        const intakeq = require('../../intakeq');
        const fetchMock = fakeFetchFactory([
            { match: () => true, respond: () => ({ body: '[{"Id":"should-not-fetch"}]' }) }
        ]);
        intakeq.__setFetch(fetchMock);

        const r = await callJson(srv.baseUrl, '/api/intakeq/files?intakeqClientId=IQ_FOREIGN');
        intakeq.__reset();

        assert.equal(r.status, 400);
        assert.match(r.body.error, /clientId query parameter is required/i);
        assert.equal(fetchMock.calls.length, 0);
    } finally {
        await srv.close();
    }
});

test('GET /api/intakeq/notes returns notes for a linked local clientId', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });
        const clientId = await insertClient(srv.db, { name: 'Linked Notes', intakeq_client_id: 'IQ_7' });

        const intakeq = require('../../intakeq');
        intakeq.__setFetch(fakeFetchFactory([
            { match: url => /\/notes\/summary\?clientId=IQ_7/.test(url), respond: () => ({ body: '[{"Id":"n1"}]' }) }
        ]));

        const r = await callJson(srv.baseUrl, `/api/intakeq/notes?clientId=${clientId}&intakeqClientId=IQ_7`);
        intakeq.__reset();

        assert.equal(r.status, 200);
        assert.deepEqual(r.body, [{ Id: 'n1' }]);
    } finally {
        await srv.close();
    }
});

test('GET /api/intakeq/notes rejects mismatched local and IntakeQ client IDs', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });
        const clientId = await insertClient(srv.db, { name: 'Linked Notes', intakeq_client_id: 'IQ_ALLOWED' });

        const intakeq = require('../../intakeq');
        const fetchMock = fakeFetchFactory([
            { match: () => true, respond: () => ({ body: '[{"Id":"should-not-fetch"}]' }) }
        ]);
        intakeq.__setFetch(fetchMock);

        const r = await callJson(srv.baseUrl, `/api/intakeq/notes?clientId=${clientId}&intakeqClientId=IQ_FOREIGN`);
        intakeq.__reset();

        assert.equal(r.status, 403);
        assert.match(r.body.error, /not linked to this local client/i);
        assert.equal(fetchMock.calls.length, 0);
    } finally {
        await srv.close();
    }
});

test('GET /api/intakeq/notes rejects local clients that are not linked to IntakeQ', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });
        const clientId = await insertClient(srv.db, { name: 'Unlinked Notes' });

        const intakeq = require('../../intakeq');
        const fetchMock = fakeFetchFactory([
            { match: () => true, respond: () => ({ body: '[{"Id":"should-not-fetch"}]' }) }
        ]);
        intakeq.__setFetch(fetchMock);

        const r = await callJson(srv.baseUrl, `/api/intakeq/notes?clientId=${clientId}`);
        intakeq.__reset();

        assert.equal(r.status, 409);
        assert.match(r.body.error, /not linked to IntakeQ/i);
        assert.equal(fetchMock.calls.length, 0);
    } finally {
        await srv.close();
    }
});

test('GET /api/intakeq/notes rejects name-only lookup without local client context', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });
        await insertClient(srv.db, { name: 'Name Only Client', intakeq_client_id: 'IQ_NAME' });

        const intakeq = require('../../intakeq');
        const fetchMock = fakeFetchFactory([
            { match: () => true, respond: () => ({ body: '[{"Id":"should-not-fetch"}]' }) }
        ]);
        intakeq.__setFetch(fetchMock);

        const r = await callJson(srv.baseUrl, '/api/intakeq/notes?clientName=Name%20Only%20Client');
        intakeq.__reset();

        assert.equal(r.status, 400);
        assert.match(r.body.error, /clientId query parameter is required/i);
        assert.equal(fetchMock.calls.length, 0);
    } finally {
        await srv.close();
    }
});

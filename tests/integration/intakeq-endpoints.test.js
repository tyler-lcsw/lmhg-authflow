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

// ============ Search-then-upload: persists intakeq_client_id ============

test('POST /api/intakeq/upload-auth/:authId searches for client and persists ClientId on first call', async () => {
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

        assert.equal(r.status, 200);
        const row = await selectOne(srv.db, 'SELECT intakeq_client_id FROM clients WHERE id = ?', [clientId]);
        assert.equal(row.intakeq_client_id, 'IQ_CLIENT_123');
        // Both search and upload should have been called
        assert.equal(fetchMock.calls.length, 2);
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

test('POST /api/intakeq/upload-auth/:authId returns 404 when IntakeQ search has no matches', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });
        const { authId } = await seedClientAndAuth(srv, { name: 'Unknown Patient' });

        const intakeq = require('../../intakeq');
        intakeq.__setFetch(fakeFetchFactory([
            { match: url => /\/clients\?search=/.test(url), respond: () => ({ body: '[]' }) }
        ]));

        const r = await callJson(srv.baseUrl, `/api/intakeq/upload-auth/${authId}`, { method: 'POST' });
        intakeq.__reset();

        assert.equal(r.status, 404);
        assert.match(r.body.error, /No client named/);
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

test('GET /api/intakeq/files returns list', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });

        const intakeq = require('../../intakeq');
        intakeq.__setFetch(fakeFetchFactory([
            { match: url => /\/files\?clientId=IQ_5/.test(url), respond: () => ({ body: '[{"Id":"a"}]' }) }
        ]));

        const r = await callJson(srv.baseUrl, '/api/intakeq/files?intakeqClientId=IQ_5');
        intakeq.__reset();

        assert.equal(r.status, 200);
        assert.deepEqual(r.body, [{ Id: 'a' }]);
    } finally {
        await srv.close();
    }
});

test('GET /api/intakeq/notes falls through to server with clientId', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });

        const intakeq = require('../../intakeq');
        intakeq.__setFetch(fakeFetchFactory([
            { match: url => /\/notes\/summary\?clientId=IQ_7/.test(url), respond: () => ({ body: '[{"Id":"n1"}]' }) }
        ]));

        const r = await callJson(srv.baseUrl, '/api/intakeq/notes?intakeqClientId=IQ_7');
        intakeq.__reset();

        assert.equal(r.status, 200);
        assert.deepEqual(r.body, [{ Id: 'n1' }]);
    } finally {
        await srv.close();
    }
});

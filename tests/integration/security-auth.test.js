const test = require('node:test');
const assert = require('node:assert');

const {
    startTestServer,
    seedSettings,
    insertClient,
    insertAuthRequest,
    selectOne,
    callJson
} = require('../helpers/testServer');

test('API routes require the configured API token', async () => {
    const srv = await startTestServer({ requireAuth: true, apiToken: 'secret-token' });
    try {
        const missing = await callJson(srv.baseUrl, '/api/clients');
        assert.equal(missing.status, 401);
        assert.match(missing.body.error, /token/i);

        const wrong = await callJson(srv.baseUrl, '/api/clients', {
            headers: { 'x-auth-token': 'wrong-token' }
        });
        assert.equal(wrong.status, 401);

        const allowed = await callJson(srv.baseUrl, '/api/clients', {
            headers: { 'x-auth-token': 'secret-token' }
        });
        assert.equal(allowed.status, 200);
    } finally {
        await srv.close();
    }
});

test('system status is token-protected and safe for agent polling', async () => {
    const srv = await startTestServer({ requireAuth: true, apiToken: 'secret-token' });
    try {
        const missing = await callJson(srv.baseUrl, '/api/system/status');
        assert.equal(missing.status, 401);

        const status = await callJson(srv.baseUrl, '/api/system/status', {
            headers: { 'x-auth-token': 'secret-token' }
        });
        assert.equal(status.status, 200);
        assert.equal(status.body.service, 'authorization-manager');
        assert.equal(status.body.dataClass, 'confirmed_ephi');
        assert.equal(status.body.safeForAgentPolling, true);
        assert.equal(status.body.clients, undefined);
        assert.equal(status.body.records, undefined);
    } finally {
        await srv.close();
    }
});

test('settings read masks write-only integration secrets', async () => {
    const srv = await startTestServer({ requireAuth: true, apiToken: 'secret-token' });
    try {
        await seedSettings(srv.db, {
            requesting_provider: 'Provider',
            srfax_access_id: 'AID_SECRET',
            srfax_access_pwd: 'PWD_SECRET',
            srfax_caller_id: '5025550100',
            intakeq_api_key: 'INTAKEQ_SECRET'
        });

        const settings = await callJson(srv.baseUrl, '/api/settings', {
            headers: { 'x-auth-token': 'secret-token' }
        });

        assert.equal(settings.status, 200);
        assert.equal(settings.body.srfax_access_id, undefined);
        assert.equal(settings.body.srfax_access_pwd, undefined);
        assert.equal(settings.body.intakeq_api_key, undefined);
        assert.equal(settings.body.srfax_access_id_configured, true);
        assert.equal(settings.body.srfax_access_pwd_configured, true);
        assert.equal(settings.body.intakeq_api_key_configured, true);
    } finally {
        await srv.close();
    }
});

test('blank secret fields preserve existing settings on update', async () => {
    const srv = await startTestServer({ requireAuth: true, apiToken: 'secret-token' });
    try {
        await seedSettings(srv.db, {
            requesting_provider: 'Provider',
            srfax_access_id: 'AID_SECRET',
            srfax_access_pwd: 'PWD_SECRET',
            srfax_caller_id: '5025550100',
            intakeq_api_key: 'INTAKEQ_SECRET'
        });

        const update = await callJson(srv.baseUrl, '/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'x-auth-token': 'secret-token' },
            body: JSON.stringify({
                requesting_provider: 'New Provider',
                req_provider_phone: '5025550101',
                req_provider_fax: '',
                completed_by: 'Staff',
                completed_by_phone: '',
                srfax_access_id: '',
                srfax_access_pwd: '',
                srfax_caller_id: '5025550100',
                srfax_sender_email: '',
                intakeq_api_key: ''
            })
        });
        assert.equal(update.status, 200);

        const row = await selectOne(
            srv.db,
            'SELECT requesting_provider, srfax_access_id, srfax_access_pwd, intakeq_api_key FROM settings WHERE id = 1'
        );
        assert.equal(row.requesting_provider, 'New Provider');
        assert.equal(row.srfax_access_id, 'AID_SECRET');
        assert.equal(row.srfax_access_pwd, 'PWD_SECRET');
        assert.equal(row.intakeq_api_key, 'INTAKEQ_SECRET');
    } finally {
        await srv.close();
    }
});

test('authenticated callers can still read PHI-bearing routes', async () => {
    const srv = await startTestServer({ requireAuth: true, apiToken: 'secret-token' });
    try {
        const clientId = await insertClient(srv.db, {
            name: 'Jane Sensitive',
            medicaid_id: '0012345678',
            dob: '1990-01-02'
        });
        await insertAuthRequest(srv.db, {
            client_id: clientId,
            form_data: JSON.stringify({ diagnosis: 'F43.10' })
        });

        const clients = await callJson(srv.baseUrl, '/api/clients', {
            headers: { 'x-auth-token': 'secret-token' }
        });
        assert.equal(clients.status, 200);
        assert.equal(clients.body[0].name, 'Jane Sensitive');

        const deniedHistory = await callJson(srv.baseUrl, `/api/clients/${clientId}/auth-requests`);
        assert.equal(deniedHistory.status, 401);

        const history = await callJson(srv.baseUrl, `/api/clients/${clientId}/auth-requests`, {
            headers: { 'x-auth-token': 'secret-token' }
        });
        assert.equal(history.status, 200);
        assert.match(history.body[0].form_data, /F43\.10/);
    } finally {
        await srv.close();
    }
});

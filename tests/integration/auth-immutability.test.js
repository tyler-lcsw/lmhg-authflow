const test = require('node:test');
const assert = require('node:assert');

const {
    startTestServer,
    insertClient,
    insertAuthRequest,
    selectOne,
    callJson
} = require('../helpers/testServer');

async function createClient(db) {
    return insertClient(db, {
        name: 'Immutable Client',
        dob: '1990-01-01',
        medicaid_id: 'M123',
        mco_id: 'A456',
        pcp: 'Primary Care Clinic',
        pcp_phone: '5025550101',
        pcp_npi: '1234567890'
    });
}

function immutableAuth(clientId, overrides = {}) {
    return {
        client_id: clientId,
        form_data: JSON.stringify({ units_1: '4', member_name: 'Immutable Client' }),
        is_draft: 1,
        record_number: 100,
        clinical_status: 'In Review',
        ...overrides
    };
}

test('POST /api/save-auth-draft allows status-only records that have not been uploaded to IntakeQ', async () => {
    const srv = await startTestServer();
    try {
        const clientId = await createClient(srv.db);
        const authId = await insertAuthRequest(srv.db, immutableAuth(clientId));

        const result = await callJson(srv.baseUrl, '/api/save-auth-draft', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: clientId,
                auth_id: authId,
                form_data: { units_1: '99' }
            })
        });

        assert.equal(result.status, 200);

        const row = await selectOne(srv.db, 'SELECT form_data, clinical_status FROM auth_requests WHERE id = ?', [authId]);
        assert.equal(JSON.parse(row.form_data).units_1, '99');
        assert.equal(row.clinical_status, 'In Review');
    } finally {
        await srv.close();
    }
});

test('POST /api/save-auth-draft refuses to overwrite an authorization uploaded to IntakeQ', async () => {
    const srv = await startTestServer();
    try {
        const clientId = await createClient(srv.db);
        const authId = await insertAuthRequest(srv.db, immutableAuth(clientId, { intakeq_uploaded_at: '2026-05-18 12:00:00' }));

        const result = await callJson(srv.baseUrl, '/api/save-auth-draft', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: clientId,
                auth_id: authId,
                form_data: { units_1: '99' }
            })
        });

        assert.equal(result.status, 409);
        assert.match(result.body.error, /immutable/i);

        const row = await selectOne(srv.db, 'SELECT form_data, clinical_status FROM auth_requests WHERE id = ?', [authId]);
        assert.equal(JSON.parse(row.form_data).units_1, '4');
        assert.equal(row.clinical_status, 'In Review');
    } finally {
        await srv.close();
    }
});

test('PUT /api/auth-requests/:id refuses form changes on immutable authorizations', async () => {
    const srv = await startTestServer();
    try {
        const clientId = await createClient(srv.db);
        const authId = await insertAuthRequest(srv.db, immutableAuth(clientId, { intakeq_uploaded_at: '2026-05-18 12:00:00' }));

        const result = await callJson(srv.baseUrl, `/api/auth-requests/${authId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ form_data: { units_1: '99' } })
        });

        assert.equal(result.status, 409);

        const row = await selectOne(srv.db, 'SELECT form_data FROM auth_requests WHERE id = ?', [authId]);
        assert.equal(JSON.parse(row.form_data).units_1, '4');
    } finally {
        await srv.close();
    }
});

test('DELETE /api/auth-requests/:id refuses immutable authorizations', async () => {
    const srv = await startTestServer();
    try {
        const clientId = await createClient(srv.db);
        const authId = await insertAuthRequest(srv.db, immutableAuth(clientId, { intakeq_uploaded_at: '2026-05-18 12:00:00' }));

        const result = await callJson(srv.baseUrl, `/api/auth-requests/${authId}`, { method: 'DELETE' });

        assert.equal(result.status, 409);
        const row = await selectOne(srv.db, 'SELECT id FROM auth_requests WHERE id = ?', [authId]);
        assert.equal(row.id, authId);
    } finally {
        await srv.close();
    }
});

test('POST /api/generate-auth refuses to replace an immutable authorization PDF', async () => {
    const srv = await startTestServer();
    try {
        const clientId = await createClient(srv.db);
        const authId = await insertAuthRequest(srv.db, immutableAuth(clientId, { pdf_path: '/tmp/original.pdf', intakeq_uploaded_at: '2026-05-18 12:00:00' }));

        const form = new FormData();
        form.append('formData', JSON.stringify({
            auth_id: authId,
            client_id: clientId,
            member_name: 'Immutable Client',
            start_date_1: '2026-05-01',
            stop_date_1: '2026-05-31',
            units_1: '99'
        }));

        const resp = await fetch(`${srv.baseUrl}/api/generate-auth`, { method: 'POST', body: form });
        const body = await resp.json();

        assert.equal(resp.status, 409);
        assert.match(body.error, /immutable/i);

        const row = await selectOne(srv.db, 'SELECT form_data, pdf_path FROM auth_requests WHERE id = ?', [authId]);
        assert.equal(JSON.parse(row.form_data).units_1, '4');
        assert.equal(row.pdf_path, '/tmp/original.pdf');
    } finally {
        await srv.close();
    }
});

test('new auto-saved authorizations start as mutable drafts', async () => {
    const srv = await startTestServer();
    try {
        const clientId = await createClient(srv.db);

        const created = await callJson(srv.baseUrl, '/api/save-auth-draft', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: clientId,
                form_data: { units_1: '4' }
            })
        });
        assert.equal(created.status, 200);

        const updated = await callJson(srv.baseUrl, '/api/save-auth-draft', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: clientId,
                auth_id: created.body.id,
                form_data: { units_1: '8' }
            })
        });
        assert.equal(updated.status, 200);

        const row = await selectOne(srv.db, 'SELECT form_data, clinical_status, is_draft FROM auth_requests WHERE id = ?', [created.body.id]);
        assert.equal(JSON.parse(row.form_data).units_1, '8');
        assert.equal(row.clinical_status, 'Draft');
        assert.equal(row.is_draft, 1);
    } finally {
        await srv.close();
    }
});

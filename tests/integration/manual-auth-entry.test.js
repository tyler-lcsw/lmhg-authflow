const test = require('node:test');
const assert = require('node:assert');

const {
    startTestServer,
    insertClient,
    selectOne,
    callJson
} = require('../helpers/testServer');

test('POST /api/auth-requests/manual records authorization dates and status without PDF workflow', async () => {
    const srv = await startTestServer();
    try {
        const clientId = await insertClient(srv.db, { name: 'Manual Monitor' });

        const response = await callJson(srv.baseUrl, '/api/auth-requests/manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: clientId,
                status: 'Granted',
                start_date: '2026-06-01',
                stop_date: '2026-11-30',
                units: '26',
                procedure_code: '90837',
                requested_service: 'Psychotherapy',
                notes: 'Imported from payer portal'
            })
        });

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.ok(response.body.id);
        assert.ok(response.body.record_number);

        const row = await selectOne(srv.db, 'SELECT * FROM auth_requests WHERE id = ?', [response.body.id]);
        const formData = JSON.parse(row.form_data);

        assert.equal(row.client_id, clientId);
        assert.equal(row.clinical_status, 'Granted');
        assert.equal(row.is_draft, 0);
        assert.equal(row.pdf_path, null);
        assert.equal(formData.manual_entry, true);
        assert.equal(formData.start_date_1, '2026-06-01');
        assert.equal(formData.stop_date_1, '2026-11-30');
        assert.equal(formData.units_1, '26');
        assert.equal(formData.procedure_code_1, '90837');
        assert.equal(formData.requested_service_1, 'Psychotherapy');
        assert.equal(formData.additional_info, 'Imported from payer portal');
    } finally {
        await srv.close();
    }
});

test('POST /api/auth-requests/manual validates required client, dates, and status', async () => {
    const srv = await startTestServer();
    try {
        const clientId = await insertClient(srv.db, { name: 'Manual Monitor' });

        const missingStop = await callJson(srv.baseUrl, '/api/auth-requests/manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: clientId,
                status: 'Granted',
                start_date: '2026-06-01'
            })
        });

        const invalidStatus = await callJson(srv.baseUrl, '/api/auth-requests/manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: clientId,
                status: 'Maybe',
                start_date: '2026-06-01',
                stop_date: '2026-11-30'
            })
        });

        const missingClient = await callJson(srv.baseUrl, '/api/auth-requests/manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: 9999,
                status: 'Granted',
                start_date: '2026-06-01',
                stop_date: '2026-11-30'
            })
        });

        const backwardsDates = await callJson(srv.baseUrl, '/api/auth-requests/manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: clientId,
                status: 'Granted',
                start_date: '2026-12-01',
                stop_date: '2026-06-01'
            })
        });

        assert.equal(missingStop.status, 400);
        assert.match(missingStop.body.error, /Start date and stop date/);
        assert.equal(invalidStatus.status, 400);
        assert.match(invalidStatus.body.error, /status/i);
        assert.equal(missingClient.status, 404);
        assert.equal(backwardsDates.status, 400);
        assert.match(backwardsDates.body.error, /Stop date/);
    } finally {
        await srv.close();
    }
});

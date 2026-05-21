const test = require('node:test');
const assert = require('node:assert');

const {
    startTestServer,
    insertClient,
    insertAuthRequest,
    selectOne,
    callJson
} = require('../helpers/testServer');

test('DELETE /api/clients/:id removes that client auth history', async () => {
    const srv = await startTestServer();
    try {
        const clientId = await insertClient(srv.db, { name: 'Delete Me' });
        await insertAuthRequest(srv.db, {
            client_id: clientId,
            form_data: JSON.stringify({ date: '2026-05-21' }),
            is_draft: 1,
            record_number: 1,
            clinical_status: 'Draft'
        });

        const deleted = await callJson(srv.baseUrl, `/api/clients/${clientId}`, { method: 'DELETE' });
        assert.equal(deleted.status, 200);

        const orphanCount = await selectOne(
            srv.db,
            'SELECT COUNT(*) AS count FROM auth_requests WHERE client_id = ?',
            [clientId]
        );
        assert.equal(orphanCount.count, 0);
    } finally {
        await srv.close();
    }
});

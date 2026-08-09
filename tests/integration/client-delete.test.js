const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
    startTestServer,
    insertClient,
    insertAuthRequest,
    selectOne,
    callJson
} = require('../helpers/testServer');

function runStatement(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

test('DELETE /api/clients/:id minimally audits auth history and removes managed PDFs', async () => {
    const srv = await startTestServer();
    try {
        const clientId = await insertClient(srv.db, { name: 'Delete Me' });
        const pdfPath = path.join(srv.outputDir, 'synthetic-client-delete.pdf');
        fs.writeFileSync(pdfPath, 'synthetic fixture');
        const authId = await insertAuthRequest(srv.db, {
            client_id: clientId,
            form_data: JSON.stringify({ date: '2026-05-21' }),
            pdf_path: pdfPath,
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
        const audit = await selectOne(
            srv.db,
            'SELECT * FROM auth_request_deletions WHERE auth_request_id = ?',
            [authId]
        );
        const pending = await selectOne(
            srv.db,
            'SELECT COUNT(*) AS count FROM auth_request_file_cleanup WHERE auth_request_id = ?',
            [authId]
        );
        assert.deepEqual(Object.keys(audit), ['id', 'auth_request_id', 'deleted_at', 'trace_id']);
        assert.equal(audit.auth_request_id, authId);
        assert.ok(audit.deleted_at);
        assert.ok(audit.trace_id);
        assert.equal(fs.existsSync(pdfPath), false);
        assert.equal(pending.count, 0);
        assert.equal(deleted.body.cleanupPending, false);
    } finally {
        await srv.close();
    }
});

test('DELETE /api/clients/:id retains retry state when managed PDF cleanup fails', async () => {
    const srv = await startTestServer();
    try {
        const clientId = await insertClient(srv.db, { name: 'Retry Cleanup' });
        const pdfPath = path.join(srv.outputDir, 'synthetic-client-cleanup-failure.pdf');
        fs.mkdirSync(pdfPath);
        const authId = await insertAuthRequest(srv.db, {
            client_id: clientId,
            form_data: JSON.stringify({ date: '2026-05-21' }),
            pdf_path: pdfPath,
            is_draft: 1,
            record_number: 2,
            clinical_status: 'Draft'
        });

        const deleted = await callJson(srv.baseUrl, `/api/clients/${clientId}`, { method: 'DELETE' });
        const pending = await selectOne(
            srv.db,
            'SELECT auth_request_id, attempts, last_error_code FROM auth_request_file_cleanup WHERE auth_request_id = ?',
            [authId]
        );

        assert.equal(deleted.status, 200);
        assert.equal(deleted.body.cleanupPending, true);
        assert.equal(pending.auth_request_id, authId);
        assert.equal(pending.attempts, 1);
        assert.match(pending.last_error_code, /^(?:EISDIR|EPERM)$/);
    } finally {
        await srv.close();
    }
});

test('DELETE /api/clients/:id refuses clients with IntakeQ-uploaded authorizations', async () => {
    const srv = await startTestServer();
    try {
        const clientId = await insertClient(srv.db, { name: 'Keep Uploaded' });
        await insertAuthRequest(srv.db, {
            client_id: clientId,
            form_data: JSON.stringify({ date: '2026-05-21' }),
            intakeq_uploaded_at: '2026-05-21 10:00:00',
            record_number: 2,
            clinical_status: 'In Review'
        });

        const deleted = await callJson(srv.baseUrl, `/api/clients/${clientId}`, { method: 'DELETE' });
        assert.equal(deleted.status, 409);
        assert.match(deleted.body.error, /immutable|uploaded/i);

        const row = await selectOne(srv.db, 'SELECT id FROM clients WHERE id = ?', [clientId]);
        assert.equal(row.id, clientId);
    } finally {
        await srv.close();
    }
});

test('DELETE /api/clients/:id refuses clients with successfully faxed authorizations', async () => {
    const srv = await startTestServer();
    try {
        const clientId = await insertClient(srv.db, { name: 'Keep Faxed' });
        const authId = await insertAuthRequest(srv.db, {
            client_id: clientId,
            form_data: JSON.stringify({ date: '2026-05-21' }),
            fax_status: 'Sent',
            fax_details_id: 'synthetic-fax-123',
            fax_sent_date: '2026-05-21 10:00:00',
            record_number: 3,
            clinical_status: 'In Review'
        });

        const deleted = await callJson(srv.baseUrl, `/api/clients/${clientId}`, { method: 'DELETE' });
        const client = await selectOne(srv.db, 'SELECT id FROM clients WHERE id = ?', [clientId]);
        const auth = await selectOne(srv.db, 'SELECT id FROM auth_requests WHERE id = ?', [authId]);
        const audit = await selectOne(
            srv.db,
            'SELECT COUNT(*) AS count FROM auth_request_deletions WHERE auth_request_id = ?',
            [authId]
        );

        assert.equal(deleted.status, 409);
        assert.match(deleted.body.error, /faxed/i);
        assert.equal(client.id, clientId);
        assert.equal(auth.id, authId);
        assert.equal(audit.count, 0);
    } finally {
        await srv.close();
    }
});

test('a forced client-delete rollback cannot absorb an unrelated database write', async () => {
    const srv = await startTestServer();
    try {
        srv.db.configure('busyTimeout', 5000);
        const clientId = await insertClient(srv.db, { name: 'Rollback Target' });
        await insertAuthRequest(srv.db, {
            client_id: clientId,
            form_data: JSON.stringify({ date: '2026-05-21' }),
            is_draft: 1,
            record_number: 4,
            clinical_status: 'Draft'
        });
        await runStatement(srv.db, `
            CREATE TRIGGER force_client_delete_rollback
            BEFORE DELETE ON auth_requests
            BEGIN
                WITH RECURSIVE delay(x) AS (
                    VALUES(0)
                    UNION ALL
                    SELECT x + 1 FROM delay WHERE x < 1000000
                )
                SELECT sum(x) FROM delay;
                SELECT RAISE(ABORT, 'forced transaction rollback');
            END
        `);

        const deletionPromise = callJson(
            srv.baseUrl,
            `/api/clients/${clientId}`,
            { method: 'DELETE' }
        );
        await new Promise(resolve => setTimeout(resolve, 20));
        const unrelatedWrite = runStatement(
            srv.db,
            'INSERT INTO mco_fax_directory (mco_name, fax_number) VALUES (?, ?)',
            ['Unrelated Synthetic MCO', '15025550199']
        );

        const [deletion] = await Promise.all([deletionPromise, unrelatedWrite]);
        const unrelated = await selectOne(
            srv.db,
            'SELECT mco_name FROM mco_fax_directory WHERE mco_name = ?',
            ['Unrelated Synthetic MCO']
        );
        const client = await selectOne(srv.db, 'SELECT id FROM clients WHERE id = ?', [clientId]);

        assert.equal(deletion.status, 500);
        assert.equal(unrelated.mco_name, 'Unrelated Synthetic MCO');
        assert.equal(client.id, clientId);
    } finally {
        await srv.close();
    }
});

const test = require('node:test');
const assert = require('node:assert');

const {
    startTestServer,
    insertClient,
    callJson
} = require('../helpers/testServer');

test('PCP directory supports create, list, update, and delete', async () => {
    const srv = await startTestServer();
    try {
        const created = await callJson(srv.baseUrl, '/api/pcp-directory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Family Clinic', phone: '502-555-0101', npi: '1234567890' })
        });
        assert.equal(created.status, 200);
        assert.ok(created.body.id);

        const listed = await callJson(srv.baseUrl, '/api/pcp-directory');
        assert.equal(listed.status, 200);
        assert.equal(listed.body.length, 1);
        assert.equal(listed.body[0].name, 'Family Clinic');
        assert.equal(listed.body[0].client_count, 0);

        const updated = await callJson(srv.baseUrl, `/api/pcp-directory/${created.body.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Updated Clinic', phone: '502-555-0199', npi: '9876543210' })
        });
        assert.equal(updated.status, 200);

        const afterUpdate = await callJson(srv.baseUrl, '/api/pcp-directory');
        assert.equal(afterUpdate.body[0].name, 'Updated Clinic');
        assert.equal(afterUpdate.body[0].phone, '1 (502) 555-0199');
        assert.equal(afterUpdate.body[0].npi, '9876543210');

        const deleted = await callJson(srv.baseUrl, `/api/pcp-directory/${created.body.id}`, { method: 'DELETE' });
        assert.equal(deleted.status, 200);

        const afterDelete = await callJson(srv.baseUrl, '/api/pcp-directory');
        assert.deepEqual(afterDelete.body, []);
    } finally {
        await srv.close();
    }
});

test('PCP directory requires name, phone, and NPI', async () => {
    const srv = await startTestServer();
    try {
        const response = await callJson(srv.baseUrl, '/api/pcp-directory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Family Clinic', phone: '', npi: '1234567890' })
        });

        assert.equal(response.status, 400);
        assert.match(response.body.error, /phone/);
    } finally {
        await srv.close();
    }
});

test('PCP directory rejects duplicate NPI even when name and phone differ', async () => {
    const srv = await startTestServer();
    try {
        const created = await callJson(srv.baseUrl, '/api/pcp-directory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Family Clinic', phone: '502-555-0101', npi: '1234567890' })
        });
        assert.equal(created.status, 200);

        const duplicate = await callJson(srv.baseUrl, '/api/pcp-directory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Renamed Clinic', phone: '502-555-0199', npi: '1234567890' })
        });

        assert.equal(duplicate.status, 409);
        assert.match(duplicate.body.error, /NPI/i);
    } finally {
        await srv.close();
    }
});

test('PCP directory prevents deleting providers assigned to clients', async () => {
    const srv = await startTestServer();
    try {
        const created = await callJson(srv.baseUrl, '/api/pcp-directory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Family Clinic', phone: '502-555-0101', npi: '1234567890' })
        });
        assert.equal(created.status, 200);

        await insertClient(srv.db, {
            name: 'Jane Doe',
            pcp: 'Family Clinic',
            pcp_phone: '502-555-0101',
            pcp_npi: '1234567890',
            primary_care_provider_id: created.body.id
        });

        const listed = await callJson(srv.baseUrl, '/api/pcp-directory');
        assert.equal(listed.body[0].client_count, 1);

        const deleted = await callJson(srv.baseUrl, `/api/pcp-directory/${created.body.id}`, { method: 'DELETE' });
        assert.equal(deleted.status, 409);
        assert.match(deleted.body.error, /assigned to 1 client/);
    } finally {
        await srv.close();
    }
});

test('PCP directory assigns an existing PCP to a client', async () => {
    const srv = await startTestServer();
    try {
        const created = await callJson(srv.baseUrl, '/api/pcp-directory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Family Clinic', phone: '502-555-0101', npi: '1234567890' })
        });
        const clientId = await insertClient(srv.db, { name: 'Jane Doe' });

        const assigned = await callJson(srv.baseUrl, `/api/pcp-directory/${created.body.id}/clients/${clientId}`, {
            method: 'PUT'
        });
        assert.equal(assigned.status, 200);

        const client = await callJson(srv.baseUrl, `/api/clients/${clientId}`);
        assert.equal(client.body.primary_care_provider_id, created.body.id);
        assert.equal(client.body.pcp, 'Family Clinic');
        assert.equal(client.body.pcp_phone, '1 (502) 555-0101');
        assert.equal(client.body.pcp_npi, '1234567890');
    } finally {
        await srv.close();
    }
});

test('PCP directory lists clients for assignment', async () => {
    const srv = await startTestServer();
    try {
        await insertClient(srv.db, { name: 'Jane Doe' });
        await insertClient(srv.db, { name: 'John Smith' });

        const response = await callJson(srv.baseUrl, '/api/pcp-directory/clients');
        assert.equal(response.status, 200);
        assert.deepEqual(response.body.map(client => client.name), ['Jane Doe', 'John Smith']);
    } finally {
        await srv.close();
    }
});

const test = require('node:test');
const assert = require('node:assert');

const {
    startTestServer,
    seedSettings,
    selectOne,
    callJson
} = require('../helpers/testServer');

function clientPayload(overrides = {}) {
    return {
        name: 'Jane Doe',
        dob: '1990-01-01',
        medicaid_id: 'M123',
        mco_id: 'A456',
        pcp: 'Eric Hospital Primary Care',
        pcp_phone: '502-555-0101',
        pcp_npi: '1234567890',
        pregnant: '',
        work_injury: '',
        mva: '',
        other_insurance: '',
        insurer: '',
        medicare_a: false,
        medicare_b: false,
        ...overrides
    };
}

async function countProviders(db) {
    const row = await selectOne(db, 'SELECT COUNT(*) AS count FROM primary_care_providers');
    return row.count;
}

test('POST /api/clients creates a shared primary care provider row', async () => {
    const srv = await startTestServer();
    try {
        const first = await callJson(srv.baseUrl, '/api/clients', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clientPayload({ name: 'Jane Doe' }))
        });
        const second = await callJson(srv.baseUrl, '/api/clients', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clientPayload({ name: 'John Doe' }))
        });

        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        assert.equal(await countProviders(srv.db), 1);

        const firstClient = await callJson(srv.baseUrl, `/api/clients/${first.body.id}`);
        const secondClient = await callJson(srv.baseUrl, `/api/clients/${second.body.id}`);
		const directory = await callJson(srv.baseUrl, '/api/pcp-directory');

        assert.equal(firstClient.body.primary_care_provider_id, secondClient.body.primary_care_provider_id);
        assert.equal(firstClient.body.pcp, 'Eric Hospital Primary Care');
        assert.equal(firstClient.body.pcp_phone, '1 (502) 555-0101');
        assert.equal(firstClient.body.pcp_npi, '1234567890');
		assert.equal(directory.status, 200);
		assert.equal(directory.body.length, 1);
		assert.equal(directory.body[0].name, 'Eric Hospital Primary Care');
		assert.equal(directory.body[0].client_count, 2);
    } finally {
        await srv.close();
    }
});

test('PUT /api/clients relinks to an existing matching primary care provider', async () => {
    const srv = await startTestServer();
    try {
        const providerClient = await callJson(srv.baseUrl, '/api/clients', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clientPayload({ name: 'Existing Provider Client' }))
        });
        const editedClient = await callJson(srv.baseUrl, '/api/clients', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clientPayload({
                name: 'Different PCP Client',
                pcp: 'Other Provider',
                pcp_phone: '502-555-0199',
                pcp_npi: '2222222222'
            }))
        });

        const update = await callJson(srv.baseUrl, `/api/clients/${editedClient.body.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clientPayload({ name: 'Different PCP Client' }))
        });

        assert.equal(providerClient.status, 200);
        assert.equal(editedClient.status, 200);
        assert.equal(update.status, 200);
        assert.equal(await countProviders(srv.db), 2);

        const first = await callJson(srv.baseUrl, `/api/clients/${providerClient.body.id}`);
        const second = await callJson(srv.baseUrl, `/api/clients/${editedClient.body.id}`);
        assert.equal(first.body.primary_care_provider_id, second.body.primary_care_provider_id);
    } finally {
        await srv.close();
    }
});

test('POST /api/clients links to an existing PCP by NPI when name and phone differ', async () => {
    const srv = await startTestServer();
    try {
        const provider = await callJson(srv.baseUrl, '/api/pcp-directory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Family Clinic', phone: '502-555-0101', npi: '1234567890' })
        });

        const created = await callJson(srv.baseUrl, '/api/clients', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clientPayload({
                pcp: 'Family Clinic Updated',
                pcp_phone: '502-555-0199',
                pcp_npi: '1234567890'
            }))
        });

        assert.equal(provider.status, 200);
        assert.equal(created.status, 200);
        assert.equal(created.body.primary_care_provider_id, provider.body.id);
        assert.equal(await countProviders(srv.db), 1);

        const client = await callJson(srv.baseUrl, `/api/clients/${created.body.id}`);
        assert.equal(client.body.primary_care_provider_id, provider.body.id);
        assert.equal(client.body.pcp, 'Family Clinic Updated');
        assert.equal(client.body.pcp_phone, '1 (502) 555-0199');
        assert.equal(client.body.pcp_npi, '1234567890');
    } finally {
        await srv.close();
    }
});

test('PUT /api/clients links to an existing PCP by NPI when name and phone differ', async () => {
    const srv = await startTestServer();
    try {
        const provider = await callJson(srv.baseUrl, '/api/pcp-directory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Family Clinic', phone: '502-555-0101', npi: '1234567890' })
        });
        const created = await callJson(srv.baseUrl, '/api/clients', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clientPayload({
                pcp: 'Other Provider',
                pcp_phone: '502-555-0199',
                pcp_npi: '2222222222'
            }))
        });

        const update = await callJson(srv.baseUrl, `/api/clients/${created.body.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clientPayload({
                pcp: 'Family Clinic Updated',
                pcp_phone: '502-555-0999',
                pcp_npi: '1234567890'
            }))
        });

        assert.equal(provider.status, 200);
        assert.equal(created.status, 200);
        assert.equal(update.status, 200);
        assert.equal(update.body.primary_care_provider_id, provider.body.id);
        assert.equal(await countProviders(srv.db), 2);
    } finally {
        await srv.close();
    }
});

test('PUT /api/clients can link by primary_care_provider_id', async () => {
    const srv = await startTestServer();
    try {
        const provider = await callJson(srv.baseUrl, '/api/pcp-directory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Family Clinic', phone: '502-555-0101', npi: '1234567890' })
        });
        const createdClient = await callJson(srv.baseUrl, '/api/clients', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clientPayload({
                pcp: 'Other Provider',
                pcp_phone: '502-555-0199',
                pcp_npi: '2222222222'
            }))
        });

        const update = await callJson(srv.baseUrl, `/api/clients/${createdClient.body.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clientPayload({
                primary_care_provider_id: provider.body.id,
                pcp: '',
                pcp_phone: '',
                pcp_npi: ''
            }))
        });
        assert.equal(update.status, 200);

        const client = await callJson(srv.baseUrl, `/api/clients/${createdClient.body.id}`);
        assert.equal(client.body.primary_care_provider_id, provider.body.id);
        assert.equal(client.body.pcp, 'Family Clinic');
        assert.equal(client.body.pcp_phone, '1 (502) 555-0101');
        assert.equal(client.body.pcp_npi, '1234567890');
    } finally {
        await srv.close();
    }
});

test('POST /api/clients requires PCP name, phone, and NPI', async () => {
    const srv = await startTestServer();
    try {
        const response = await callJson(srv.baseUrl, '/api/clients', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clientPayload({ pcp_npi: '' }))
        });

        assert.equal(response.status, 400);
        assert.match(response.body.error, /PCP NPI/);
    } finally {
        await srv.close();
    }
});

test('POST /api/clients does not write PCP fields back to IntakeQ during local save', async () => {
    const srv = await startTestServer();
    try {
        await seedSettings(srv.db, { intakeq_api_key: 'KEY' });

        const calls = [];
        const intakeq = require('../../intakeq');
        intakeq.__setFetch(async (url, init = {}) => {
            calls.push({ url, init });
            return {
                ok: true,
                status: 200,
                text: async () => '{"ClientId":42}'
            };
        });

        const response = await callJson(srv.baseUrl, '/api/clients', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clientPayload({
                intakeq_client_id: 42,
                pcp_custom_field_ids: {
                    pcp: 'name_1',
                    pcp_phone: 'phone_1',
                    pcp_npi: 'npi_1'
                }
            }))
        });
        intakeq.__reset();

        assert.equal(response.status, 200);
        assert.equal(response.body.intakeq_pcp_sync.skipped, true);
        assert.match(response.body.intakeq_pcp_sync.reason, /local-only/i);
        assert.equal(calls.length, 0);
    } finally {
        await srv.close();
    }
});

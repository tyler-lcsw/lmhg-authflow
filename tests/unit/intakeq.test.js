const test = require('node:test');
const assert = require('node:assert');
const intakeq = require('../../intakeq');

function fakeResponse({ ok = true, status = 200, body = '' } = {}) {
    return {
        ok,
        status,
        headers: {
            get: () => null
        },
        text: async () => body
    };
}

function mockFetch(handler) {
    const calls = [];
    const fn = async (url, init) => {
        calls.push({ url, init });
        return handler(url, init);
    };
    fn.calls = calls;
    return fn;
}

// ===== safeParseJson — the regression coverage for the reported bug =====

test('safeParseJson returns {} for empty body', async () => {
    const result = await intakeq.safeParseJson(fakeResponse({ body: '' }));
    assert.deepEqual(result, {});
});

test('safeParseJson returns parsed object for valid JSON', async () => {
    const result = await intakeq.safeParseJson(fakeResponse({ body: '{"id":42,"name":"x"}' }));
    assert.deepEqual(result, { id: 42, name: 'x' });
});

test('safeParseJson returns parsed array for JSON array', async () => {
    const result = await intakeq.safeParseJson(fakeResponse({ body: '[1,2,3]' }));
    assert.deepEqual(result, [1, 2, 3]);
});

test('safeParseJson wraps non-JSON body in {raw: ...} (no throw — this is the bug fix)', async () => {
    const result = await intakeq.safeParseJson(fakeResponse({ body: 'FILE_ID_99' }));
    assert.deepEqual(result, { raw: 'FILE_ID_99' });
});

test('safeParseJson handles HTML body without throwing', async () => {
    const result = await intakeq.safeParseJson(fakeResponse({ body: '<html>oops</html>' }));
    assert.deepEqual(result, { raw: '<html>oops</html>' });
});

// ===== searchClients =====

test('searchClients builds correct URL and headers', async () => {
    const fetch = mockFetch(async () => fakeResponse({ body: '[]' }));
    await intakeq.searchClients('KEY', 'Jane Doe', { fetch });
    assert.equal(fetch.calls.length, 1);
    assert.match(fetch.calls[0].url, /clients\?search=Jane%20Doe&includeProfile=true$/);
    assert.equal(fetch.calls[0].init.headers['X-Auth-Key'], 'KEY');
    assert.equal(fetch.calls[0].init.method, 'GET');
});

test('searchClients throws with status on non-ok response', async () => {
    const fetch = mockFetch(async () => fakeResponse({ ok: false, status: 401, body: 'bad key' }));
    await assert.rejects(
        () => intakeq.searchClients('KEY', 'x', { fetch }),
        /IntakeQ API Error: 401/
    );
});

test('searchClients throws with method and sanitized URL on non-ok response', async () => {
    const fetch = mockFetch(async () => fakeResponse({ ok: false, status: 500, body: 'upstream failed' }));

    try {
        await intakeq.searchClients('KEY', 'Jane Doe', { fetch });
        assert.fail('Expected searchClients to throw');
    } catch (err) {
        assert.equal(err.status, 500);
        assert.equal(err.method, 'GET');
        assert.equal(err.upstream, 'IntakeQ');
        assert.match(err.url, /\/clients\?search=Jane%20Doe&includeProfile=true$/);
        assert.doesNotMatch(err.url, /KEY/);
    }
});

test('searchClients sends an AbortSignal for bounded upstream timeouts', async () => {
    const fetch = mockFetch(async () => fakeResponse({ body: '[]' }));

    await intakeq.searchClients('KEY', 'Jane Doe', { fetch, timeoutMs: 1000 });

    assert.ok(fetch.calls[0].init.signal);
    assert.equal(typeof fetch.calls[0].init.signal.aborted, 'boolean');
});

test('searchClients aborts a slow upstream request after the configured timeout', async () => {
    const fetch = mockFetch((url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted by test signal')));
    }));

    await assert.rejects(
        () => intakeq.searchClients('KEY', 'Jane Doe', { fetch, timeoutMs: 1 }),
        /aborted by test signal/
    );
});

test('searchClients rejects when the upstream response exceeds the configured byte cap', async () => {
    const fetch = mockFetch(async () => fakeResponse({ body: '123456789' }));

    await assert.rejects(
        () => intakeq.searchClients('KEY', 'Jane Doe', { fetch, maxResponseBytes: 4 }),
        /IntakeQ API response exceeded 4 bytes/
    );
});

test('extractPcpCustomFields maps PCP custom field labels from client profile', () => {
    const result = intakeq.extractPcpCustomFields({
        CustomFields: [
            { FieldId: 'name_1', Text: 'Primary Care Name', Value: 'Family Clinic' },
            { FieldId: 'phone_1', Text: 'Primary Care Phone', Value: '502-555-0101' },
            { FieldId: 'npi_1', Text: 'Primary Care NPI', Value: '1234567890' }
        ]
    });

    assert.deepEqual(result, {
        pcp: 'Family Clinic',
        pcp_phone: '502-555-0101',
        pcp_npi: '1234567890',
        fieldIds: {
            pcp: 'name_1',
            pcp_phone: 'phone_1',
            pcp_npi: 'npi_1'
        }
    });
});

test('updateClientPcpCustomFields POSTs minimal ClientId and CustomFields payload', async () => {
    const fetch = mockFetch(async () => fakeResponse({ body: '{"ClientId":42}' }));

    const result = await intakeq.updateClientPcpCustomFields(
        'KEY',
        42,
        {
            pcp: 'Family Clinic',
            pcp_phone: '502-555-0101',
            pcp_npi: '1234567890'
        },
        {
            fieldIds: { pcp: 'name_1', pcp_phone: 'phone_1', pcp_npi: 'npi_1' },
            fetch,
            clientName: 'Jane Doe'
        }
    );

    assert.deepEqual(result, { ClientId: 42 });
    assert.equal(fetch.calls.length, 1);
    assert.match(fetch.calls[0].url, /\/clients$/);
    assert.equal(fetch.calls[0].init.method, 'POST');
    assert.equal(fetch.calls[0].init.headers['X-Auth-Key'], 'KEY');
    assert.equal(fetch.calls[0].init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(fetch.calls[0].init.body), {
        ClientId: 42,
        FirstName: 'Jane',
        LastName: 'Doe',
        CustomFields: [
            { FieldId: 'name_1', Value: 'Family Clinic' },
            { FieldId: 'phone_1', Value: '502-555-0101' },
            { FieldId: 'npi_1', Value: '1234567890' }
        ]
    });
});

test('updateClientPcpCustomFields uses a placeholder last name for single-token client names', async () => {
    const fetch = mockFetch(async () => fakeResponse({ body: '{"ClientId":42}' }));

    await intakeq.updateClientPcpCustomFields(
        'KEY',
        42,
        { pcp: 'Family Clinic' },
        {
            fieldIds: { pcp: 'name_1' },
            fetch,
            clientName: 'Madonna'
        }
    );

    assert.deepEqual(JSON.parse(fetch.calls[0].init.body), {
        ClientId: 42,
        FirstName: 'Madonna',
        LastName: '.',
        CustomFields: [
            { FieldId: 'name_1', Value: 'Family Clinic' }
        ]
    });
});

test('updateClientPcpCustomFields discovers field IDs from existing client when not provided', async () => {
    const fetch = mockFetch(async (url, init) => {
        if ((init.method || 'GET') === 'GET') {
            return fakeResponse({
                body: JSON.stringify([
                    {
                        ClientId: 42,
                        CustomFields: [
                            { FieldId: 'name_1', Text: 'Primary Care Provider', Value: 'Old' },
                            { FieldId: 'phone_1', Text: 'PCP Phone', Value: 'Old' },
                            { FieldId: 'npi_1', Text: 'PCP NPI', Value: 'Old' }
                        ]
                    }
                ])
            });
        }
        return fakeResponse({ body: '{"ok":true}' });
    });

    await intakeq.updateClientPcpCustomFields(
        'KEY',
        42,
        { pcp: 'New', pcp_phone: '502', pcp_npi: '123' },
        { fetch }
    );

    assert.equal(fetch.calls.length, 2);
    assert.match(fetch.calls[0].url, /\/clients\?search=42&includeProfile=true$/);
    assert.deepEqual(JSON.parse(fetch.calls[1].init.body).CustomFields, [
        { FieldId: 'name_1', Value: 'New' },
        { FieldId: 'phone_1', Value: '502' },
        { FieldId: 'npi_1', Value: '123' }
    ]);
});

// ===== getNotesSummary =====

test('getNotesSummary uses clientId path when provided', async () => {
    const fetch = mockFetch(async () => fakeResponse({ body: '[]' }));
    await intakeq.getNotesSummary('KEY', { clientId: 'C42' }, { fetch });
    assert.match(fetch.calls[0].url, /notes\/summary\?clientId=C42$/);
});

test('getNotesSummary falls back to clientName when no clientId', async () => {
    const fetch = mockFetch(async () => fakeResponse({ body: '[]' }));
    await intakeq.getNotesSummary('KEY', { clientName: 'Jane Doe' }, { fetch });
    assert.match(fetch.calls[0].url, /notes\/summary\?client=Jane%20Doe$/);
});

test('getNotesSummary throws when neither id nor name given', async () => {
    await assert.rejects(
        () => intakeq.getNotesSummary('KEY', {}),
        /requires clientId or clientName/
    );
});

// ===== listFiles =====

test('listFiles builds correct URL', async () => {
    const fetch = mockFetch(async () => fakeResponse({ body: '[]' }));
    await intakeq.listFiles('KEY', 'C99', { fetch });
    assert.match(fetch.calls[0].url, /files\?clientId=C99$/);
});

// ===== uploadFile — the endpoint with the reported bug =====

test('uploadFile POSTs to /files/:clientId with auth key + FormData', async () => {
    const fetch = mockFetch(async () => fakeResponse({ body: '{"Id":"abc"}' }));
    const result = await intakeq.uploadFile('KEY', 'C42', Buffer.from('pdf'), 'test.pdf', { fetch });
    assert.equal(fetch.calls.length, 1);
    assert.match(fetch.calls[0].url, /\/files\/C42$/);
    assert.equal(fetch.calls[0].init.method, 'POST');
    assert.ok(fetch.calls[0].init.signal);
    assert.equal(fetch.calls[0].init.headers['X-Auth-Key'], 'KEY');
    // FormData sets a content-type with a multipart boundary
    assert.match(fetch.calls[0].init.headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.deepEqual(result, { Id: 'abc' });
});

test('uploadFile rejects oversized successful response bodies', async () => {
    const fetch = mockFetch(async () => fakeResponse({ body: '{"large":true}' }));

    await assert.rejects(
        () => intakeq.uploadFile('KEY', 'C42', Buffer.from('pdf'), 'test.pdf', {
            fetch,
            maxResponseBytes: 4
        }),
        /IntakeQ API response exceeded 4 bytes/
    );
});

test('uploadFile returns {} on empty 200 body (regression test)', async () => {
    const fetch = mockFetch(async () => fakeResponse({ body: '' }));
    const result = await intakeq.uploadFile('KEY', 'C42', Buffer.from('pdf'), 'test.pdf', { fetch });
    assert.deepEqual(result, {});
});

test('uploadFile returns {raw: ...} on non-JSON 200 body (regression test for reported bug)', async () => {
    const fetch = mockFetch(async () => fakeResponse({ body: 'FILE_99' }));
    const result = await intakeq.uploadFile('KEY', 'C42', Buffer.from('pdf'), 'test.pdf', { fetch });
    assert.deepEqual(result, { raw: 'FILE_99' });
});

test('uploadFile throws on non-ok response', async () => {
    const fetch = mockFetch(async () => fakeResponse({ ok: false, status: 413, body: 'too big' }));
    await assert.rejects(
        () => intakeq.uploadFile('KEY', 'C42', Buffer.from('pdf'), 'test.pdf', { fetch }),
        /IntakeQ upload failed: 413/
    );
});

const test = require('node:test');
const assert = require('node:assert');

const { startTestServer } = require('../helpers/testServer');

test('POST /api/generate-auth rejects non-PDF attachments before generation', async () => {
    const srv = await startTestServer();
    try {
        const body = new FormData();
        body.append('formData', JSON.stringify({ client_id: 1, date: '2026-05-21' }));
        body.append('attachments', new Blob(['not a pdf'], { type: 'text/plain' }), 'notes.txt');

        const response = await fetch(`${srv.baseUrl}/api/generate-auth`, {
            method: 'POST',
            body
        });
        const result = await response.json();

        assert.equal(response.status, 400);
        assert.match(result.error, /PDF/i);
    } finally {
        await srv.close();
    }
});

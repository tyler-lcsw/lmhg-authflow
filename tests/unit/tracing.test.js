const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const {
    createRequestTracer,
    createErrorLogger
} = require('../../tracing');

function startApp(app) {
    return new Promise(resolve => {
        const server = app.listen(0, () => {
            resolve({
                baseUrl: `http://127.0.0.1:${server.address().port}`,
                close: () => new Promise(r => server.close(r))
            });
        });
    });
}

test('request tracer emits request completion with trace id and duration', async () => {
    const entries = [];
    const app = express();

    app.use(createRequestTracer({ sink: entry => entries.push(entry) }));
    app.get('/ok', (req, res) => {
        assert.ok(req.traceId);
        res.json({ traceId: req.traceId });
    });

    const server = await startApp(app);
    try {
        const response = await fetch(`${server.baseUrl}/ok`);
        const body = await response.json();

        assert.equal(response.headers.get('x-trace-id'), body.traceId);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].event, 'request.complete');
        assert.equal(entries[0].method, 'GET');
        assert.equal(entries[0].path, '/ok');
        assert.equal(entries[0].status, 200);
        assert.equal(entries[0].trace_id, body.traceId);
        assert.equal(typeof entries[0].duration_ms, 'number');
    } finally {
        await server.close();
    }
});

test('error logger emits request error with trace id and message', async () => {
    const entries = [];
    const app = express();

    app.use(createRequestTracer({ sink: entry => entries.push(entry) }));
    app.get('/boom', () => {
        throw new Error('diagnostic failure');
    });
    app.use(createErrorLogger({ sink: entry => entries.push(entry) }));

    const server = await startApp(app);
    try {
        const response = await fetch(`${server.baseUrl}/boom`);
        const body = await response.json();

        assert.equal(response.status, 500);
        assert.equal(response.headers.get('x-trace-id'), body.traceId);

        const errorEntry = entries.find(entry => entry.event === 'request.error');
        assert.ok(errorEntry);
        assert.equal(errorEntry.message, 'diagnostic failure');
        assert.equal(errorEntry.trace_id, body.traceId);
        assert.equal(errorEntry.method, 'GET');
        assert.equal(errorEntry.path, '/boom');
    } finally {
        await server.close();
    }
});

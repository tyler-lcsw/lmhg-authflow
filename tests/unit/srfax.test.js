const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const { sendFax, checkFaxStatus, srfaxPost } = require('../../srfax');

function mockPoster() {
    const calls = [];
    const fn = async (payload, options) => {
        calls.push(payload);
        fn.options.push(options);
        return { Status: 'Success', Result: '12345678' };
    };
    fn.calls = calls;
    fn.options = [];
    return fn;
}

const validCreds = {
    access_id: 'AID',
    access_pwd: 'APW',
    caller_id: '5025550100',
    sender_email: 'sender@example.com'
};
const pdfBuf = Buffer.from('%PDF-1.4 fake');

test('sendFax throws when access_id is missing', async () => {
    await assert.rejects(
        () => sendFax({ access_pwd: 'x', caller_id: '5025550100' }, '15021234567', 'f.pdf', pdfBuf, { post: mockPoster() }),
        /Missing SRFax credentials/
    );
});

test('sendFax throws when caller_id is missing', async () => {
    await assert.rejects(
        () => sendFax({ access_id: 'x', access_pwd: 'y' }, '15021234567', 'f.pdf', pdfBuf, { post: mockPoster() }),
        /Missing SRFax credentials/
    );
});

test('sendFax throws on 9-digit caller ID', async () => {
    await assert.rejects(
        () => sendFax({ ...validCreds, caller_id: '502416141' }, '15021234567', 'f.pdf', pdfBuf, { post: mockPoster() }),
        /exactly 10 digits/
    );
});

test('sendFax accepts a normalized 11-digit caller ID and sends SRFax the required 10-digit caller ID', async () => {
    const post = mockPoster();
    await sendFax({ ...validCreds, caller_id: '1 (502) 555-0100' }, '15021234567', 'f.pdf', pdfBuf, { post });
    assert.equal(post.calls[0].sCallerID, '5025550100');
});

test('sendFax throws on 10-digit toFax (missing country code)', async () => {
    await assert.rejects(
        () => sendFax(validCreds, '5021234567', 'f.pdf', pdfBuf, { post: mockPoster() }),
        /exactly 11 digits/
    );
});

test('sendFax throws on 12-digit toFax', async () => {
    await assert.rejects(
        () => sendFax(validCreds, '150212345678', 'f.pdf', pdfBuf, { post: mockPoster() }),
        /exactly 11 digits/
    );
});

test('sendFax strips non-digits from caller ID and toFax', async () => {
    const post = mockPoster();
    await sendFax({ ...validCreds, caller_id: '(502) 555-0100' }, '1-502-123-4567', 'f.pdf', pdfBuf, { post });
    assert.equal(post.calls.length, 1);
    assert.equal(post.calls[0].sCallerID, '5025550100');
    assert.equal(post.calls[0].sToFaxNumber, '15021234567');
});

test('sendFax builds correct Queue_Fax payload', async () => {
    const post = mockPoster();
    await sendFax(validCreds, '15021234567', 'auth.pdf', pdfBuf, { post });
    const p = post.calls[0];
    assert.equal(p.action, 'Queue_Fax');
    assert.equal(p.access_id, 'AID');
    assert.equal(p.access_pwd, 'APW');
    assert.equal(p.sCallerID, '5025550100');
    assert.equal(p.sSenderEmail, 'sender@example.com');
    assert.equal(p.sFaxType, 'SINGLE');
    assert.equal(p.sToFaxNumber, '15021234567');
    assert.equal(p.sResponseFormat, 'JSON');
    assert.equal(p.sFileName_1, 'auth.pdf');
    assert.equal(p.sFileContent_1, pdfBuf.toString('base64'));
});

test('sendFax defaults sender email to empty string when missing', async () => {
    const post = mockPoster();
    const { sender_email, ...creds } = validCreds;
    await sendFax(creds, '15021234567', 'f.pdf', pdfBuf, { post });
    assert.equal(post.calls[0].sSenderEmail, '');
});

test('sendFax returns the poster result verbatim', async () => {
    const post = async () => ({ Status: 'Success', Result: 'FAX_ID_42' });
    const result = await sendFax(validCreds, '15021234567', 'f.pdf', pdfBuf, { post });
    assert.deepEqual(result, { Status: 'Success', Result: 'FAX_ID_42' });
});

test('sendFax forwards timeout and response-size limits to the SRFax poster', async () => {
    const post = mockPoster();
    await sendFax(validCreds, '15021234567', 'f.pdf', pdfBuf, {
        post,
        timeoutMs: 123,
        maxResponseBytes: 456
    });

    assert.deepEqual(post.options[0], {
        timeoutMs: 123,
        maxResponseBytes: 456
    });
});

test('checkFaxStatus builds correct Get_FaxStatus payload', async () => {
    const post = mockPoster();
    await checkFaxStatus({ access_id: 'A', access_pwd: 'B' }, 'FID123', { post });
    const p = post.calls[0];
    assert.equal(p.action, 'Get_FaxStatus');
    assert.equal(p.access_id, 'A');
    assert.equal(p.access_pwd, 'B');
    assert.equal(p.sFaxDetailsID, 'FID123');
    assert.equal(p.sResponseFormat, 'JSON');
});

test('checkFaxStatus forwards timeout and response-size limits to the SRFax poster', async () => {
    const post = mockPoster();
    await checkFaxStatus({ access_id: 'A', access_pwd: 'B' }, 'FID123', {
        post,
        timeoutMs: 321,
        maxResponseBytes: 654
    });

    assert.deepEqual(post.options[0], {
        timeoutMs: 321,
        maxResponseBytes: 654
    });
});

test('srfaxPost rejects when response exceeds the configured byte cap', async () => {
    const originalRequest = https.request;
    https.request = (options, onResponse) => {
        const req = new EventEmitter();
        req.write = () => {};
        req.end = () => {
            const res = new EventEmitter();
            onResponse(res);
            res.emit('data', Buffer.from('12345'));
        };
        req.setTimeout = () => {};
        req.destroy = err => req.emit('error', err);
        return req;
    };

    try {
        await assert.rejects(
            () => srfaxPost({ action: 'Get_FaxStatus' }, { maxResponseBytes: 4 }),
            /SRFax response exceeded 4 bytes/
        );
    } finally {
        https.request = originalRequest;
    }
});

test('srfaxPost destroys slow requests after the configured timeout', async () => {
    const originalRequest = https.request;
    https.request = (options, onResponse) => {
        const req = new EventEmitter();
        req.write = () => {};
        req.end = () => {};
        req.setTimeout = (timeoutMs, handler) => {
            assert.equal(timeoutMs, 7);
            setImmediate(handler);
        };
        req.destroy = err => req.emit('error', err);
        return req;
    };

    try {
        await assert.rejects(
            () => srfaxPost({ action: 'Get_FaxStatus' }, { timeoutMs: 7 }),
            /SRFax request timed out after 7ms/
        );
    } finally {
        https.request = originalRequest;
    }
});

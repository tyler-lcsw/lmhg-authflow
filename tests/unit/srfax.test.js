const test = require('node:test');
const assert = require('node:assert');
const { sendFax, checkFaxStatus } = require('../../srfax');

function mockPoster() {
    const calls = [];
    const fn = async (payload) => {
        calls.push(payload);
        return { Status: 'Success', Result: '12345678' };
    };
    fn.calls = calls;
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

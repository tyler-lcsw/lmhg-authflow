const https = require('https');

const SRFAX_URL = 'https://www.srfax.com/SRF_SecWebSvc.php';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

function responseLimitError(limit) {
    const err = new Error(`SRFax response exceeded ${limit} bytes`);
    err.code = 'SRFAX_RESPONSE_TOO_LARGE';
    err.upstream = 'SRFax';
    return err;
}

function srfaxPost(data, { timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES } = {}) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(data);
        const url = new URL(SRFAX_URL);

        const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        let settled = false;
        function fail(err) {
            if (settled) return;
            settled = true;
            reject(err);
        }

        const req = https.request(options, (res) => {
            const chunks = [];
            let total = 0;
            res.on('data', chunk => {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                total += buf.length;
                if (total > maxResponseBytes) {
                    req.destroy(responseLimitError(maxResponseBytes));
                    return;
                }
                chunks.push(buf);
            });
            res.on('end', () => {
                if (settled) return;
                settled = true;
                const body = Buffer.concat(chunks).toString('utf8');
                try {
                    const parsed = JSON.parse(body);
                    resolve(parsed);
                } catch (e) {
                    reject(new Error(`Failed to parse SRFax response: ${body}`));
                }
            });
        });

        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`SRFax request timed out after ${timeoutMs}ms`));
        });
        req.on('error', fail);
        req.write(postData);
        req.end();
    });
}

let defaultPoster = srfaxPost;
function __setPoster(fn) { defaultPoster = fn || srfaxPost; }
function __resetPoster() { defaultPoster = srfaxPost; }

function normalizeCallerId(value) {
    const digits = String(value).replace(/\D/g, '');
    return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

async function sendFax(creds, toFaxNumber, fileName, fileBuffer, { post, timeoutMs, maxResponseBytes } = {}) {
    if (!creds.access_id || !creds.access_pwd || !creds.caller_id) {
        throw new Error('Missing SRFax credentials: access_id, access_pwd, or caller_id.');
    }

    const formattedCallerID = normalizeCallerId(creds.caller_id);
    const formattedToNumber = String(toFaxNumber).replace(/\D/g, '');

    if (formattedCallerID.length !== 10) {
        throw new Error(`Invalid Sender Fax Number (Caller ID): ${formattedCallerID}. Must be exactly 10 digits.`);
    }
    if (formattedToNumber.length !== 11) {
        throw new Error(`Invalid Recipient Fax Number: ${formattedToNumber}. Must be exactly 11 digits (e.g. 15021234567).`);
    }

    const fileBase64 = fileBuffer.toString('base64');

    const payload = {
        action: 'Queue_Fax',
        access_id: creds.access_id,
        access_pwd: creds.access_pwd,
        sCallerID: formattedCallerID,
        sSenderEmail: creds.sender_email || '',
        sFaxType: 'SINGLE',
        sToFaxNumber: formattedToNumber,
        sResponseFormat: 'JSON',
        sFileName_1: fileName,
        sFileContent_1: fileBase64
    };

    return (post || defaultPoster)(payload, { timeoutMs, maxResponseBytes });
}

async function checkFaxStatus(creds, faxDetailsID, { post, timeoutMs, maxResponseBytes } = {}) {
    const payload = {
        action: 'Get_FaxStatus',
        access_id: creds.access_id,
        access_pwd: creds.access_pwd,
        sFaxDetailsID: faxDetailsID,
        sResponseFormat: 'JSON'
    };

    return (post || defaultPoster)(payload, { timeoutMs, maxResponseBytes });
}

module.exports = {
    sendFax,
    checkFaxStatus,
    srfaxPost,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_RESPONSE_BYTES,
    __setPoster,
    __resetPoster
};

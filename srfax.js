const https = require('https');

const SRFAX_URL = 'https://www.srfax.com/SRF_SecWebSvc.php';

function srfaxPost(data) {
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

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    resolve(parsed);
                } catch (e) {
                    reject(new Error(`Failed to parse SRFax response: ${body}`));
                }
            });
        });

        req.on('error', reject);
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

async function sendFax(creds, toFaxNumber, fileName, fileBuffer, { post } = {}) {
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

    return (post || defaultPoster)(payload);
}

async function checkFaxStatus(creds, faxDetailsID, { post } = {}) {
    const payload = {
        action: 'Get_FaxStatus',
        access_id: creds.access_id,
        access_pwd: creds.access_pwd,
        sFaxDetailsID: faxDetailsID,
        sResponseFormat: 'JSON'
    };

    return (post || defaultPoster)(payload);
}

module.exports = { sendFax, checkFaxStatus, srfaxPost, __setPoster, __resetPoster };

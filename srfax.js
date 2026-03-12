const https = require('https');

const SRFAX_URL = 'https://www.srfax.com/SRF_SecWebSvc.php';

/**
 * Generic POST to SRFax API
 */
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

/**
 * Queue a fax with a PDF file
 * @param {Object} creds - { access_id, access_pwd, caller_id, sender_email }
 * @param {string} toFaxNumber - 11-digit recipient fax number
 * @param {string} fileName - name of the PDF file (e.g. "auth_request.pdf")
 * @param {Buffer} fileBuffer - raw PDF file contents
 * @returns {Promise<{Status: string, Result: string}>}
 */
async function sendFax(creds, toFaxNumber, fileName, fileBuffer) {
    // Validate inputs
    if (!creds.access_id || !creds.access_pwd || !creds.caller_id) {
        throw new Error('Missing SRFax credentials: access_id, access_pwd, or caller_id.');
    }

    // SRFax specific formatting: CallerID must be 10 digits, ToNumber must be 11 digits (including country code)
    const formattedCallerID = creds.caller_id.replace(/\D/g, '');
    const formattedToNumber = toFaxNumber.replace(/\D/g, '');

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

    return srfaxPost(payload);
}

/**
 * Check the delivery status of a fax
 * @param {Object} creds - { access_id, access_pwd }
 * @param {string} faxDetailsID - the FaxDetailsID from Queue_Fax
 * @returns {Promise<{Status: string, Result: Object|string}>}
 */
async function checkFaxStatus(creds, faxDetailsID) {
    const payload = {
        action: 'Get_FaxStatus',
        access_id: creds.access_id,
        access_pwd: creds.access_pwd,
        sFaxDetailsID: faxDetailsID,
        sResponseFormat: 'JSON'
    };

    return srfaxPost(payload);
}

module.exports = { sendFax, checkFaxStatus };

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const ejs = require('ejs');
const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

const db = require('./db');
const { sendFax, checkFaxStatus } = require('./srfax');

const app = express();
const port = 3000;

/**
 * Re-saves a PDF buffer through pdf-lib to normalize the format for SRFax compatibility.
 * SRFax's converter can't handle PDFs with certain features Puppeteer outputs by default.
 */
async function normalizePdfForFax(inputBuffer) {
    const pdfDoc = await PDFDocument.load(inputBuffer, { ignoreEncryption: true });
    const normalizedBytes = await pdfDoc.save();
    return Buffer.from(normalizedBytes);
}

function getNextRecordNumber() {
    return new Promise((resolve, reject) => {
        db.get("SELECT MAX(record_number) as maxNum FROM auth_requests", (err, row) => {
            if (err) reject(err);
            else resolve((row && row.maxNum ? row.maxNum : 0) + 1);
        });
    });
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // serve frontend
app.set('view engine', 'ejs');

// Multer setup for handling PDF uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// Ensure directories exist
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('output')) fs.mkdirSync('output');

// === API ROUTES ===

// --- Clients ---
app.get('/api/clients', (req, res) => {
    db.all("SELECT * FROM clients", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/clients/:id', (req, res) => {
    db.get("SELECT * FROM clients WHERE id = ?", [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Client not found" });
        res.json(row);
    });
});

app.post('/api/clients', (req, res) => {
    const data = req.body;
    if (!data.name) return res.status(400).json({ error: "Client Name is required" });

    const stmt = db.prepare(`
        INSERT INTO clients (
            name, medicaid_id, mco_id, dob, pregnant, pcp, pcp_phone, pcp_npi,
            work_injury, mva, other_insurance, insurer, medicare_a, medicare_b, intakeq_client_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
        [
            data.name, data.medicaid_id, data.mco_id, data.dob, data.pregnant,
            data.pcp, data.pcp_phone, data.pcp_npi, data.work_injury, data.mva,
            data.other_insurance, data.insurer, data.medicare_a, data.medicare_b,
            data.intakeq_client_id || null
        ],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID });
        }
    );
    stmt.finalize();
});

app.put('/api/clients/:id', (req, res) => {
    const data = req.body;
    if (!data.name) return res.status(400).json({ error: "Client Name is required" });

    const stmt = db.prepare(`
        UPDATE clients SET
            name=?, medicaid_id=?, mco_id=?, dob=?, pregnant=?, pcp=?, pcp_phone=?, pcp_npi=?,
            work_injury=?, mva=?, other_insurance=?, insurer=?, medicare_a=?, medicare_b=?,
            intakeq_client_id=COALESCE(?, intakeq_client_id)
        WHERE id=?
    `);
    stmt.run(
        [
            data.name, data.medicaid_id, data.mco_id, data.dob, data.pregnant,
            data.pcp, data.pcp_phone, data.pcp_npi, data.work_injury, data.mva,
            data.other_insurance, data.insurer, data.medicare_a, data.medicare_b,
            data.intakeq_client_id || null,
            req.params.id
        ],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ changes: this.changes });
        }
    );
    stmt.finalize();
});

app.delete('/api/clients/:id', (req, res) => {
    db.run("DELETE FROM clients WHERE id = ?", [req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ changes: this.changes });
    });
});

// --- Settings ---
app.get('/api/settings', (req, res) => {
    db.get("SELECT * FROM settings WHERE id = 1", [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || {});
    });
});

app.put('/api/settings', (req, res) => {
    const data = req.body;
    
    // Basic validation
    if (!data.requesting_provider) return res.status(400).json({ error: "Requesting Provider Name is required" });
    
    // SRFax Validation
    if (data.srfax_caller_id && data.srfax_caller_id.replace(/\D/g, '').length !== 10) {
        return res.status(400).json({ error: "SRFax Caller ID must be exactly 10 digits (no country code)." });
    }

    const stmt = db.prepare(`
        UPDATE settings SET
            requesting_provider=?, req_provider_phone=?, req_provider_npi=?, req_provider_fax=?,
            completed_by=?, completed_by_phone=?,
            srfax_access_id=?, srfax_access_pwd=?, srfax_caller_id=?, srfax_sender_email=?,
            intakeq_api_key=?
        WHERE id=1
    `);
    stmt.run(
        [
            data.requesting_provider, data.req_provider_phone, data.req_provider_npi, data.req_provider_fax,
            data.completed_by, data.completed_by_phone,
            data.srfax_access_id, data.srfax_access_pwd, data.srfax_caller_id, data.srfax_sender_email,
            data.intakeq_api_key
        ],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ changes: this.changes });
        }
    );
    stmt.finalize();
});

// --- Provider Presets (Still mapped to /api/facilities for now) ---
app.get('/api/facilities', (req, res) => {
    db.all("SELECT * FROM provider_presets", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/facilities', (req, res) => {
    const data = req.body;
    if (!data.name) return res.status(400).json({ error: "Provider Preset Name is required" });

    const stmt = db.prepare(`
        INSERT INTO provider_presets (
            name, requesting_provider, req_provider_npi, req_provider_phone, req_provider_fax,
            servicing_provider, serv_provider_npi, serv_provider_tax_id,
            serv_provider_address, serv_provider_city, serv_provider_state,
            serv_provider_zip, serv_provider_phone, serv_provider_fax
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
        [
            data.name, data.requesting_provider, data.req_provider_npi, data.req_provider_phone, data.req_provider_fax,
            data.servicing_provider, data.serv_provider_npi, data.serv_provider_tax_id,
            data.serv_provider_address, data.serv_provider_city, data.serv_provider_state,
            data.serv_provider_zip, data.serv_provider_phone, data.serv_provider_fax
        ],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID });
        }
    );
    stmt.finalize();
});

app.put('/api/facilities/:id', (req, res) => {
    const data = req.body;
    if (!data.name) return res.status(400).json({ error: "Provider Preset Name is required" });

    const stmt = db.prepare(`
        UPDATE provider_presets SET
            name=?, requesting_provider=?, req_provider_npi=?, req_provider_phone=?, req_provider_fax=?,
            servicing_provider=?, serv_provider_npi=?, serv_provider_tax_id=?,
            serv_provider_address=?, serv_provider_city=?, serv_provider_state=?,
            serv_provider_zip=?, serv_provider_phone=?, serv_provider_fax=?
        WHERE id=?
    `);
    stmt.run(
        [
            data.name, data.requesting_provider, data.req_provider_npi, data.req_provider_phone, data.req_provider_fax,
            data.servicing_provider, data.serv_provider_npi, data.serv_provider_tax_id,
            data.serv_provider_address, data.serv_provider_city, data.serv_provider_state,
            data.serv_provider_zip, data.serv_provider_phone, data.serv_provider_fax,
            req.params.id
        ],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ changes: this.changes });
        }
    );
    stmt.finalize();
});

app.delete('/api/facilities/:id', (req, res) => {
    db.run("DELETE FROM provider_presets WHERE id = ?", [req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ changes: this.changes });
    });
});

// --- Auth Requests & PDF Generation ---
app.get('/api/clients/:id/auth-requests', (req, res) => {
    db.all("SELECT id, date_created, last_updated, is_draft, fax_status, fax_to_number, fax_details_id, form_data, record_number, clinical_status, fax_sent_date FROM auth_requests WHERE client_id = ? ORDER BY COALESCE(last_updated, date_created) DESC", [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/auth-requests/all', (req, res) => {
    const query = `
        SELECT 
            a.id, 
            a.client_id,
            a.form_data,
            a.clinical_status,
            a.is_draft,
            c.name as client_name
        FROM auth_requests a
        JOIN clients c ON a.client_id = c.id
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/fax-log', (req, res) => {
    const query = `
        SELECT 
            a.id, 
            a.client_id,
            a.date_created, 
            a.fax_status, 
            a.fax_sent_date, 
            a.fax_to_number, 
            c.name as client_name
        FROM auth_requests a
        JOIN clients c ON a.client_id = c.id
        WHERE a.fax_sent_date IS NOT NULL
        ORDER BY a.fax_sent_date DESC
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/save-auth-draft', (req, res) => {
    const { client_id, auth_id, form_data } = req.body;
    if (!client_id || !form_data) return res.status(400).json({ error: "Client ID and form data required" });

    const formDataStr = typeof form_data === 'string' ? form_data : JSON.stringify(form_data);

    if (auth_id) {
        db.run(
            "UPDATE auth_requests SET form_data = ?, is_draft = 1, last_updated = datetime('now') WHERE id = ?",
            [formDataStr, auth_id],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ id: auth_id, success: true });
            }
        );
    } else {
        getNextRecordNumber().then(num => {
            db.run(
                "INSERT INTO auth_requests (client_id, form_data, is_draft, last_updated, record_number) VALUES (?, ?, 1, datetime('now'), ?)",
                [client_id, formDataStr, num],
                function (err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ id: this.lastID, record_number: num, success: true });
                }
            );
        }).catch(err => res.status(500).json({ error: err.message }));
    }
});

app.get('/api/auth-requests/:id', (req, res) => {
    db.get("SELECT * FROM auth_requests WHERE id = ?", [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Not found" });
        res.json(row);
    });
});

app.get('/api/auth-requests/:id/download', (req, res) => {
    db.get("SELECT pdf_path FROM auth_requests WHERE id = ?", [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row || !fs.existsSync(row.pdf_path)) return res.status(404).json({ error: "Not found" });
        res.download(row.pdf_path);
    });
});

app.get('/api/auth-requests/:id/preview', (req, res) => {
    db.get("SELECT pdf_path FROM auth_requests WHERE id = ?", [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row || !fs.existsSync(row.pdf_path)) return res.status(404).json({ error: "Not found" });
        res.sendFile(row.pdf_path);
    });
});

app.delete('/api/auth-requests/:id', (req, res) => {
    db.get("SELECT pdf_path FROM auth_requests WHERE id = ?", [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row && row.pdf_path && fs.existsSync(row.pdf_path)) {
            try { fs.unlinkSync(row.pdf_path); } catch (e) { }
        }
        db.run("DELETE FROM auth_requests WHERE id = ?", [req.params.id], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ changes: this.changes });
        });
    });
});

app.put('/api/auth-requests/:id', (req, res) => {
    const { form_data, clinical_status } = req.body;
    let query = "UPDATE auth_requests SET ";
    let params = [];
    if (form_data) {
        query += "form_data = ?, ";
        params.push(typeof form_data === 'string' ? form_data : JSON.stringify(form_data));
    }
    if (clinical_status) {
        query += "clinical_status = ?, ";
        params.push(clinical_status);
    }
    query = query.slice(0, -2); // Remove trailing comma
    query += " WHERE id = ?";
    params.push(req.params.id);

    db.run(query, params, function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: "Not found" });
        res.json({ changes: this.changes });
    });
});

app.post('/api/generate-auth', upload.array('attachments', 10), async (req, res) => {
    try {
        const formDataStr = req.body.formData;
        if (!formDataStr) {
            return res.status(400).json({ error: "No form data provided" });
        }

        const formData = JSON.parse(formDataStr);
        const clientId = formData.client_id;
        const authId = formData.auth_id;

        // Hardcode Servicing Facility details
        Object.assign(formData, {
            servicing_facility: "Louisville Mental Health Group",
            serv_facility_npi: "1386140358",
            serv_facility_tax_id: "820604469",
            serv_facility_address: "4229 Bardstown Road #310",
            serv_facility_city: "Louisville",
            serv_facility_state: "KY",
            serv_facility_zip: "40218",
            serv_facility_phone: "5024161416",
            serv_facility_fax: "8889771527"
        });

        // Fetch client and settings to merge with form data (optional, frontend might send it all)
        // Assume frontend sends everything needed for the EJS template inside formData.

        // 1. Render HTML
        const html = await ejs.renderFile(path.join(__dirname, 'views/form_template.ejs'), { data: formData });

        // 2. Generate PDF from HTML using Puppeteer
        const browser = await puppeteer.launch({ headless: 'new' });
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const formPdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', bottom: '0', left: '0', right: '0' } });
        await browser.close();

        // 3. Merge with attachments using pdf-lib
        const mergedPdf = await PDFDocument.create();
        const mainDoc = await PDFDocument.load(formPdfBuffer);
        const mainPages = await mergedPdf.copyPages(mainDoc, mainDoc.getPageIndices());
        mainPages.forEach(page => mergedPdf.addPage(page));

        // 3a. Merge IntakeQ Notes if requested
        if (req.body.intakeqNotes) {
            try {
                const noteIds = JSON.parse(req.body.intakeqNotes);
                if (Array.isArray(noteIds) && noteIds.length > 0) {
                    
                    // Fetch API key
                    const settings = await new Promise((resolve, reject) => {
                        db.get("SELECT intakeq_api_key FROM settings WHERE id = 1", (err, row) => {
                            if (err) reject(err); else resolve(row || {});
                        });
                    });

                    if (settings.intakeq_api_key) {
                        const fetch = (await import('node-fetch')).default;
                        
                        for (const noteId of noteIds) {
                            const response = await fetch(`https://intakeq.com/api/v1/notes/${noteId}/pdf`, {
                                method: 'GET',
                                headers: { 'X-Auth-Key': settings.intakeq_api_key }
                            });
                            
                            if (response.ok) {
                                const arrayBuffer = await response.arrayBuffer();
                                const notePdfBuffer = Buffer.from(arrayBuffer);
                                
                                const noteDoc = await PDFDocument.load(notePdfBuffer);
                                const notePages = await mergedPdf.copyPages(noteDoc, noteDoc.getPageIndices());
                                notePages.forEach(page => mergedPdf.addPage(page));
                            } else {
                                console.error(`Failed to fetch IntakeQ PDF for note ${noteId}: ${response.status}`);
                            }
                        }
                    }
                }
            } catch (err) {
                console.error("Error processing IntakeQ notes attachment:", err);
            }
        }

        // 3b. Merge Local File Attachments
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                const attachmentBuffer = fs.readFileSync(file.path);
                const attachDoc = await PDFDocument.load(attachmentBuffer);
                const attachPages = await mergedPdf.copyPages(attachDoc, attachDoc.getPageIndices());
                attachPages.forEach(page => mergedPdf.addPage(page));
                // Clean up uploaded file
                fs.unlinkSync(file.path);
            }
        }

        const finalPdfBytes = await mergedPdf.save();
        const filename = `auth_request_client_${clientId}_${Date.now()}.pdf`;
        const filepath = path.join(__dirname, 'output', filename);
        fs.writeFileSync(filepath, finalPdfBytes);

        // 4. Save record to DB
        if (authId) {
            db.get("SELECT pdf_path FROM auth_requests WHERE id = ?", [authId], (err, row) => {
                if (row && row.pdf_path && fs.existsSync(row.pdf_path)) {
                    try { fs.unlinkSync(row.pdf_path); } catch (e) { }
                }
                db.run("UPDATE auth_requests SET form_data = ?, pdf_path = ?, is_draft = 0, last_updated = datetime('now'), date_created = CURRENT_TIMESTAMP WHERE id = ?",
                    [formDataStr, filepath, authId], function (err) {
                        if (err) console.error("Error updating auth request:", err);
                    }
                );
            });
        } else {
            getNextRecordNumber().then(num => {
                db.run("INSERT INTO auth_requests (client_id, form_data, pdf_path, is_draft, last_updated, record_number) VALUES (?, ?, ?, 0, datetime('now'), ?)",
                    [clientId, formDataStr, filepath, num], function (err) {
                        if (err) console.error("Error saving auth request:", err);
                    });
            }).catch(err => console.error("Error generating record number:", err));
        }

        // 5. Send file to client
        res.download(filepath);

    } catch (err) {
        console.error("PDF Generation Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- SRFax Integration ---
app.post('/api/send-fax/:authId', async (req, res) => {
    try {
        const authId = req.params.authId;
        const { toFaxNumber } = req.body;

        if (!toFaxNumber) return res.status(400).json({ error: "Recipient fax number is required" });

        // Get SRFax credentials from settings
        const settings = await new Promise((resolve, reject) => {
            db.get("SELECT srfax_access_id, srfax_access_pwd, srfax_caller_id, srfax_sender_email FROM settings WHERE id = 1", (err, row) => {
                if (err) reject(err);
                else resolve(row || {});
            });
        });

        if (!settings.srfax_access_id || !settings.srfax_access_pwd) {
            return res.status(400).json({ error: "SRFax credentials not configured. Go to Settings to set them up." });
        }
        if (!settings.srfax_caller_id) {
            return res.status(400).json({ error: "SRFax Caller ID (sender fax number) not configured in Settings." });
        }

        // Get auth request PDF path
        const auth = await new Promise((resolve, reject) => {
            db.get("SELECT pdf_path FROM auth_requests WHERE id = ?", [authId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!auth || !auth.pdf_path || !fs.existsSync(auth.pdf_path)) {
            return res.status(404).json({ error: "PDF not found for this auth request. Regenerate it first." });
        }

        // Read PDF and send fax
        const pdfBuffer = fs.readFileSync(auth.pdf_path);
        const fileName = path.basename(auth.pdf_path);

        const creds = {
            access_id: settings.srfax_access_id,
            access_pwd: settings.srfax_access_pwd,
            caller_id: settings.srfax_caller_id,
            sender_email: settings.srfax_sender_email || 'noreply@authforms.local'
        };

        const normalizedBuffer = await normalizePdfForFax(pdfBuffer);
        const result = await sendFax(creds, toFaxNumber, fileName, normalizedBuffer);

        if (result.Status === 'Success') {
            // Store fax details in DB
            db.run(
                "UPDATE auth_requests SET fax_details_id = ?, fax_status = 'In Progress', fax_sent_date = datetime('now'), fax_to_number = ?, clinical_status = 'Pending' WHERE id = ?",
                [result.Result, toFaxNumber, authId]
            );
            res.json({ success: true, faxDetailsId: result.Result, message: "Fax queued successfully" });
        } else {
            // Log failure in DB
            db.run(
                "UPDATE auth_requests SET fax_status = 'Failed', fax_sent_date = datetime('now'), fax_to_number = ? WHERE id = ?",
                [toFaxNumber, authId]
            );
            res.status(400).json({ error: `SRFax error: ${result.Result}` });
        }

    } catch (err) {
        console.error("Send Fax Error:", err);
        // Also log unexpected errors to database
        db.run(
            "UPDATE auth_requests SET fax_status = 'Error', fax_sent_date = datetime('now') WHERE id = ?",
            [req.params.authId]
        );
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/check-fax-status/:authId', async (req, res) => {
    try {
        const authId = req.params.authId;

        // Get fax_details_id from auth
        const auth = await new Promise((resolve, reject) => {
            db.get("SELECT fax_details_id FROM auth_requests WHERE id = ?", [authId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!auth || !auth.fax_details_id) {
            return res.status(400).json({ error: "No fax has been sent for this auth request." });
        }

        // Get SRFax credentials
        const settings = await new Promise((resolve, reject) => {
            db.get("SELECT srfax_access_id, srfax_access_pwd FROM settings WHERE id = 1", (err, row) => {
                if (err) reject(err);
                else resolve(row || {});
            });
        });

        const creds = {
            access_id: settings.srfax_access_id,
            access_pwd: settings.srfax_access_pwd
        };

        const result = await checkFaxStatus(creds, auth.fax_details_id);

        if (result.Status === 'Success') {
            const sentStatus = result.Result.SentStatus || 'Unknown';
            db.run("UPDATE auth_requests SET fax_status = ? WHERE id = ?", [sentStatus, authId]);
            res.json({ success: true, faxStatus: sentStatus, details: result.Result });
        } else {
            res.status(400).json({ error: `SRFax error: ${result.Result}` });
        }

    } catch (err) {
        console.error("Check Fax Status Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- MCO Fax Directory ---
app.get('/api/mco-fax-directory', (req, res) => {
    db.all("SELECT * FROM mco_fax_directory ORDER BY mco_name", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/mco-fax-directory', (req, res) => {
    const { mco_name, fax_number } = req.body;
    if (!mco_name || !fax_number) return res.status(400).json({ error: "MCO name and fax number required" });
    
    const cleanFax = fax_number.replace(/\D/g, '');
    if (cleanFax.length !== 11) {
        return res.status(400).json({ error: "MCO Fax Number must be exactly 11 digits (e.g. 15021234567)." });
    }

    db.run("INSERT INTO mco_fax_directory (mco_name, fax_number) VALUES (?, ?)", [mco_name, cleanFax], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID });
    });
});

app.put('/api/mco-fax-directory/:id', (req, res) => {
    const { mco_name, fax_number } = req.body;
    db.run("UPDATE mco_fax_directory SET mco_name = ?, fax_number = ? WHERE id = ?", [mco_name, fax_number, req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ changes: this.changes });
    });
});

app.delete('/api/mco-fax-directory/:id', (req, res) => {
    db.run("DELETE FROM mco_fax_directory WHERE id = ?", [req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ changes: this.changes });
    });
});
app.post('/api/send-test-fax', async (req, res) => {
    try {
        // 1. Get Settings
        const settings = await new Promise((resolve, reject) => {
            db.get("SELECT srfax_access_id, srfax_access_pwd, srfax_caller_id, srfax_sender_email FROM settings WHERE id = 1", (err, row) => {
                if (err) reject(err);
                else resolve(row || {});
            });
        });

        if (!settings.srfax_access_id || !settings.srfax_access_pwd || !settings.srfax_caller_id) {
            return res.status(400).json({ error: "SRFax credentials or Caller ID not configured." });
        }

        // 2. Generate small Test PDF
        const browser = await puppeteer.launch({ headless: 'new' });
        const page = await browser.newPage();
        await page.setContent("<h1>SRFax Test Page</h1><p>This is a test fax sent from the Auth Flow application.</p><p>Sent back to the configured Caller ID.</p>", { waitUntil: 'networkidle0' });
        const testPdfBuffer = await page.pdf({ format: 'A4' });
        await browser.close();

        // 3. Send back to caller ID (prefix with 1 if 10 digits)
        const callerId = settings.srfax_caller_id.replace(/\D/g, '');
        const toFax = callerId.length === 10 ? '1' + callerId : callerId;

        console.log(`[TEST FAX] Sending to: ${toFax} | Caller ID: ${callerId} | AccessID: ${settings.srfax_access_id}`);

        const creds = {
            access_id: settings.srfax_access_id,
            access_pwd: settings.srfax_access_pwd,
            caller_id: callerId,
            sender_email: settings.srfax_sender_email || 'test@authforms.local'
        };

        const normalizedTestBuffer = await normalizePdfForFax(testPdfBuffer);
        const result = await sendFax(creds, toFax, 'test_fax.pdf', normalizedTestBuffer);
        console.log(`[TEST FAX] SRFax raw response:`, JSON.stringify(result));

        if (result.Status === 'Success') {
            res.json({ success: true, faxDetailsId: result.Result, message: `Test fax queued successfully to ${toFax}. FaxID: ${result.Result}` });
        } else {
            res.status(400).json({ error: `SRFax error: ${result.Result}`, raw: result, toFax, callerId });
        }
    } catch (err) {
        console.error("Test Fax Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- Fax Diagnostic ---
app.post('/api/diag-fax', async (req, res) => {
    try {
        const settings = await new Promise((resolve, reject) => {
            db.get("SELECT srfax_access_id, srfax_access_pwd, srfax_caller_id, srfax_sender_email FROM settings WHERE id = 1", (err, row) => {
                if (err) reject(err);
                else resolve(row || {});
            });
        });

        const callerId = (settings.srfax_caller_id || '').replace(/\D/g, '');
        const toFax = callerId.length === 10 ? '1' + callerId : callerId;

        res.json({
            access_id: settings.srfax_access_id ? settings.srfax_access_id.substring(0,4) + '****' : 'NOT SET',
            access_pwd: settings.srfax_access_pwd ? '****' : 'NOT SET',
            caller_id_raw: settings.srfax_caller_id,
            caller_id_cleaned: callerId,
            caller_id_length: callerId.length,
            to_fax_would_be: toFax,
            to_fax_length: toFax.length,
            sender_email: settings.srfax_sender_email || 'NOT SET',
            all_valid: !!(settings.srfax_access_id && settings.srfax_access_pwd && callerId.length === 10 && toFax.length === 11)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- IntakeQ Integration ---
app.get('/api/intakeq/notes', async (req, res) => {
    try {
        const clientName = req.query.clientName;
        const intakeqClientId = req.query.intakeqClientId; // preferred — direct numeric lookup
        const localClientId = req.query.localClientId;     // if provided, we can persist discovered IQid

        if (!clientName && !intakeqClientId) {
            return res.status(400).json({ error: "Either clientName or intakeqClientId query parameter is required" });
        }

        const settings = await new Promise((resolve, reject) => {
            db.get("SELECT intakeq_api_key FROM settings WHERE id = 1", (err, row) => {
                if (err) reject(err);
                else resolve(row || {});
            });
        });

        if (!settings.intakeq_api_key) {
            return res.status(400).json({ error: "IntakeQ API Key not configured in Settings." });
        }

        const fetch = (await import('node-fetch')).default;

        // Build the query: prefer clientId for exact match, fall back to name search
        const notesUrl = intakeqClientId
            ? `https://intakeq.com/api/v1/notes/summary?clientId=${intakeqClientId}`
            : `https://intakeq.com/api/v1/notes/summary?client=${encodeURIComponent(clientName)}`;

        const response = await fetch(notesUrl, {
            method: 'GET',
            headers: { 'X-Auth-Key': settings.intakeq_api_key }
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`IntakeQ API Error: ${response.status} - ${errText}`);
        }

        const notes = await response.json();
        res.json(notes);
    } catch (err) {
        console.error("IntakeQ Notes Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- IntakeQ: Client Search (for Auto-Sync) ---
app.get('/api/intakeq/client-search', async (req, res) => {
    try {
        const name = req.query.name;
        if (!name) return res.status(400).json({ error: "name query parameter is required" });

        const settings = await new Promise((resolve, reject) => {
            db.get("SELECT intakeq_api_key FROM settings WHERE id = 1", (err, row) => {
                if (err) reject(err);
                else resolve(row || {});
            });
        });

        if (!settings.intakeq_api_key) {
            return res.status(400).json({ error: "IntakeQ API Key not configured in Settings." });
        }

        const fetch = (await import('node-fetch')).default;
        const response = await fetch(`https://intakeq.com/api/v1/clients?search=${encodeURIComponent(name)}&includeProfile=true`, {
            method: 'GET',
            headers: { 'X-Auth-Key': settings.intakeq_api_key }
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`IntakeQ API Error: ${response.status} - ${errText}`);
        }

        const clients = await response.json();
        res.json(clients);
    } catch (err) {
        console.error("IntakeQ Client Search Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- IntakeQ: Upload Auth PDF to EMR (Feature #6) ---
app.post('/api/intakeq/upload-auth/:authId', async (req, res) => {
    try {
        const authId = req.params.authId;

        // Get auth record including the client's stored IntakeQ ID if available
        const auth = await new Promise((resolve, reject) => {
            db.get("SELECT a.pdf_path, a.client_id, c.name as client_name, c.intakeq_client_id FROM auth_requests a JOIN clients c ON a.client_id = c.id WHERE a.id = ?", [authId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!auth || !auth.pdf_path || !fs.existsSync(auth.pdf_path)) {
            return res.status(404).json({ error: "PDF not found for this auth request. Generate it first." });
        }

        const settings = await new Promise((resolve, reject) => {
            db.get("SELECT intakeq_api_key FROM settings WHERE id = 1", (err, row) => {
                if (err) reject(err);
                else resolve(row || {});
            });
        });

        if (!settings.intakeq_api_key) {
            return res.status(400).json({ error: "IntakeQ API Key not configured in Settings." });
        }

        const fetch = (await import('node-fetch')).default;
        const FormData = (await import('form-data')).default;

        let intakeqClientId = auth.intakeq_client_id;

        // Only do a name search if we don't already have the stored IntakeQ client ID
        if (!intakeqClientId) {
            const searchResp = await fetch(`https://intakeq.com/api/v1/clients?search=${encodeURIComponent(auth.client_name)}&includeProfile=true`, {
                headers: { 'X-Auth-Key': settings.intakeq_api_key }
            });

            if (!searchResp.ok) {
                const errText = await searchResp.text();
                throw new Error(`IntakeQ client lookup failed: ${searchResp.status} - ${errText}`);
            }

            const matchedClients = await searchResp.json();

            if (!Array.isArray(matchedClients) || matchedClients.length === 0) {
                return res.status(404).json({ error: `No client named "${auth.client_name}" found in IntakeQ. Use Sync from IntakeQ first to link this client.` });
            }

            const intakeqClient = matchedClients[0];
            intakeqClientId = intakeqClient.ClientId || intakeqClient.ClientNumber;

            if (!intakeqClientId) {
                return res.status(404).json({ error: "Could not determine IntakeQ Client ID from search results." });
            }

            // Persist the discovered ID so future calls skip this search
            db.run("UPDATE clients SET intakeq_client_id = ? WHERE id = ?", [String(intakeqClientId), auth.client_id]);
        }

        // Upload the PDF to the client's IntakeQ file gallery
        const pdfBuffer = fs.readFileSync(auth.pdf_path);
        const formData = new FormData();
        formData.append('file', pdfBuffer, {
            filename: `AuthRequest_${auth.client_name.replace(/ /g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`,
            contentType: 'application/pdf'
        });

        const uploadResp = await fetch(`https://intakeq.com/api/v1/files/${intakeqClientId}`, {
            method: 'POST',
            headers: {
                'X-Auth-Key': settings.intakeq_api_key,
                ...formData.getHeaders()
            },
            body: formData
        });

        if (!uploadResp.ok) {
            const errText = await uploadResp.text();
            throw new Error(`IntakeQ upload failed: ${uploadResp.status} - ${errText}`);
        }

        const uploadResult = await uploadResp.json();
        res.json({ success: true, message: `Auth PDF uploaded to IntakeQ for "${auth.client_name}" (IntakeQ Client #${intakeqClientId})`, file: uploadResult });
    } catch (err) {
        console.error("IntakeQ Upload Auth Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- Server Start ---
app.listen(port, () => {

    console.log(`Auth Forms app listening at http://localhost:${port}`);
});

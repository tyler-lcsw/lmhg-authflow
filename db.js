const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // Clients table
    db.run(`
        CREATE TABLE IF NOT EXISTS clients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            medicaid_id TEXT,
            mco_id TEXT,
            dob TEXT,
            pregnant TEXT,
            pcp TEXT,
            pcp_phone TEXT,
            pcp_npi TEXT,
            work_injury TEXT,
            mva TEXT,
            other_insurance TEXT,
            insurer TEXT,
            medicare_a BOOLEAN,
            medicare_b BOOLEAN
        )
    `);

    // Settings table (Provider / Facility info)
    db.run(`
        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            requesting_provider TEXT,
            req_provider_phone TEXT,
            req_provider_npi TEXT,
            req_provider_fax TEXT,
            
            servicing_provider TEXT,
            serv_provider_npi TEXT,
            serv_provider_tax_id TEXT,
            serv_provider_address TEXT,
            serv_provider_city TEXT,
            serv_provider_state TEXT,
            serv_provider_zip TEXT,
            serv_provider_phone TEXT,
            serv_provider_fax TEXT,
            
            servicing_facility TEXT,
            serv_facility_npi TEXT,
            serv_facility_tax_id TEXT,
            serv_facility_address TEXT,
            serv_facility_city TEXT,
            serv_facility_state TEXT,
            serv_facility_zip TEXT,
            serv_facility_phone TEXT,
            serv_facility_fax TEXT,
            
            completed_by TEXT,
            completed_by_phone TEXT
        )
    `);

    // Provider Presets (CRUD)
    db.run(`
        CREATE TABLE IF NOT EXISTS provider_presets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            requesting_provider TEXT,
            req_provider_npi TEXT,
            req_provider_phone TEXT,
            req_provider_fax TEXT,
            
            servicing_provider TEXT,
            serv_provider_npi TEXT,
            serv_provider_tax_id TEXT,
            serv_provider_address TEXT,
            serv_provider_city TEXT,
            serv_provider_state TEXT,
            serv_provider_zip TEXT,
            serv_provider_phone TEXT,
            serv_provider_fax TEXT
        )
    `);

    // Insert default settings row if it doesn't exist
    db.run(`INSERT OR IGNORE INTO settings (id) VALUES (1)`);

    // Auth Requests table
    db.run(`
        CREATE TABLE IF NOT EXISTS auth_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_id INTEGER,
            date_created DATETIME DEFAULT CURRENT_TIMESTAMP,
            form_data TEXT, -- JSON string of all form fields not in clients/settings
            pdf_path TEXT,
            fax_details_id TEXT,
            fax_status TEXT,
            fax_sent_date TEXT,
            fax_to_number TEXT,
            FOREIGN KEY (client_id) REFERENCES clients(id)
        )
    `);

    // MCO Fax Directory table
    db.run(`
        CREATE TABLE IF NOT EXISTS mco_fax_directory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mco_name TEXT NOT NULL,
            fax_number TEXT NOT NULL
        )
    `);

    // -- Migration: add columns to existing tables if they don't exist --
    const alterQueries = [
        "ALTER TABLE settings ADD COLUMN srfax_access_id TEXT",
        "ALTER TABLE settings ADD COLUMN srfax_access_pwd TEXT",
        "ALTER TABLE settings ADD COLUMN srfax_caller_id TEXT",
        "ALTER TABLE settings ADD COLUMN srfax_sender_email TEXT",
        "ALTER TABLE settings ADD COLUMN intakeq_api_key TEXT",
        "ALTER TABLE auth_requests ADD COLUMN fax_details_id TEXT",
        "ALTER TABLE auth_requests ADD COLUMN fax_status TEXT",
        "ALTER TABLE auth_requests ADD COLUMN fax_sent_date TEXT",
        "ALTER TABLE auth_requests ADD COLUMN fax_to_number TEXT",
        "ALTER TABLE auth_requests ADD COLUMN is_draft INTEGER DEFAULT 0",
        "ALTER TABLE auth_requests ADD COLUMN last_updated TEXT",
        "ALTER TABLE auth_requests ADD COLUMN record_number INTEGER",
        "ALTER TABLE auth_requests ADD COLUMN clinical_status TEXT DEFAULT 'In Review'",
        "ALTER TABLE clients ADD COLUMN intakeq_client_id TEXT"
    ];
    alterQueries.forEach(q => {
        db.run(q, (err) => { /* ignore "duplicate column" errors */ });
    });

    // Initialize record_number for existing records if they don't have one
    db.run("UPDATE auth_requests SET record_number = id WHERE record_number IS NULL", (err) => {
        if (err) console.error("Error initializing record_numbers:", err);
    });
    
    // Migration: Copy from facilities to provider_presets (mapping old schema to new)
    db.all("SELECT * FROM sqlite_master WHERE type='table' AND name='facilities'", [], (err, tables) => {
        if (tables && tables.length > 0) {
            db.all("SELECT * FROM facilities", [], (err, rows) => {
                if (err) return;
                rows.forEach(row => {
                    db.get("SELECT id FROM provider_presets WHERE name = ?", [row.name], (err, preset) => {
                        if (!preset) {
                            db.run(`
                                INSERT INTO provider_presets (
                                    name, requesting_provider, req_provider_npi, req_provider_phone, req_provider_fax,
                                    servicing_provider, serv_provider_npi, serv_provider_tax_id, serv_provider_address,
                                    serv_provider_city, serv_provider_state, serv_provider_zip, serv_provider_phone, serv_provider_fax
                                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            `, [
                                row.name, '', '', '', '', // Original facilities table didn't have Requesting Provider, only Settings did
                                row.servicing_provider, row.serv_provider_npi, row.serv_provider_tax_id, row.serv_provider_address,
                                row.serv_provider_city, row.serv_provider_state, row.serv_provider_zip, row.serv_provider_phone, row.serv_provider_fax
                            ]);
                        }
                    });
                });
            });
            // Don't drop facilities yet, rename it to avoid breaking older APIs running concurrently
            db.run("ALTER TABLE facilities RENAME TO old_facilities", (err) => {});
        }
    });
    
    console.log("Database initialized at", dbPath);
});

module.exports = db;


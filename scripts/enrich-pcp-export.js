#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
    normalizePcpRows,
    buildNppesQueries,
    selectBestMatch,
    formatEnrichedDirectoryRow,
    formatProviderLocationRows,
    verifyEnrichedDirectoryRow
} = require('../lib/pcp-enrichment');

const DEFAULT_INPUT = '/Users/tyler-lcsw/Downloads/pcp_export.csv';
const DEFAULT_OUTPUT_ROOT = path.join(process.cwd(), 'output', 'pcp-enrichment');
const NPPES_ENDPOINT = 'https://npiregistry.cms.hhs.gov/api/';

function parseArgs(argv) {
    const args = {
        input: DEFAULT_INPUT,
        outputRoot: DEFAULT_OUTPUT_ROOT,
        delayMs: 125,
        maxCandidates: 0
    };
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === '--input') {
            args.input = next;
            i += 1;
        } else if (arg === '--output-root') {
            args.outputRoot = next;
            i += 1;
        } else if (arg === '--delay-ms') {
            args.delayMs = Number(next);
            i += 1;
        } else if (arg === '--max-candidates') {
            args.maxCandidates = Number(next);
            i += 1;
        }
    }
    return args;
}

function timestampForPath() {
    return new Date().toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, 'Z');
}

function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        const next = text[i + 1];

        if (char === '"' && inQuotes && next === '"') {
            cell += '"';
            i += 1;
        } else if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            row.push(cell);
            cell = '';
        } else if ((char === '\n' || char === '\r') && !inQuotes) {
            if (char === '\r' && next === '\n') i += 1;
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
        } else {
            cell += char;
        }
    }

    if (cell || row.length) {
        row.push(cell);
        rows.push(row);
    }

    const [headers, ...dataRows] = rows.filter(line => line.some(value => value !== ''));
    return dataRows.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
}

function csvEscape(value) {
    const stringValue = neutralizeSpreadsheetFormula(value);
    if (/[",\n\r]/.test(stringValue)) {
        return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
}

function neutralizeSpreadsheetFormula(value) {
    const stringValue = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(stringValue)) {
        return `'${stringValue}`;
    }
    return stringValue;
}

function writeCsv(filePath, rows, headers) {
    const headerLine = headers.map(csvEscape).join(',');
    const lines = rows.map(row => headers.map(header => csvEscape(row[header])).join(','));
    fs.writeFileSync(filePath, [headerLine, ...lines].join('\n'));
}

function queryCacheKey(params) {
    return new URLSearchParams(params).toString();
}

function buildNppesUrl(params) {
    const url = new URL(NPPES_ENDPOINT);
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
    return url;
}

async function sleep(ms) {
    if (!ms) return;
    await new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchNppes(params, cache, delayMs) {
    const key = queryCacheKey(params);
    if (cache[key]) return cache[key];

    const url = buildNppesUrl(params);
    const response = await fetch(url);
    const text = await response.text();
    let body;
    try {
        body = JSON.parse(text);
    } catch (error) {
        body = { Errors: [{ description: `Non-JSON response: ${text.slice(0, 120)}` }] };
    }

    cache[key] = {
        url: url.toString(),
        status: response.status,
        fetchedAt: new Date().toISOString(),
        body
    };
    await sleep(delayMs);
    return cache[key];
}

function dedupeResults(results) {
    const byNpi = new Map();
    for (const result of results) {
        if (result?.number && !byNpi.has(result.number)) byNpi.set(result.number, result);
    }
    return [...byNpi.values()];
}

function normalizedGroupRow(candidate) {
    return {
        'Candidate ID': candidate.id,
        'Display Name': candidate.displayName,
        'Provider Kind': candidate.providerKind,
        'Parsed First Name': candidate.firstName,
        'Parsed Last Name': candidate.lastName,
        'Parsed Title': candidate.title,
        'Parsed Credential': candidate.credential,
        'Source Phones': candidate.sourcePhones.join('; '),
        'Source Faxes': candidate.sourceFaxes.join('; '),
        'Raw Name Variants': candidate.rawNames.join('; '),
        'Raw Row Count': String(candidate.rawRowCount),
        'Review Reasons': candidate.reviewReasons.join('; ')
    };
}

function sourceLogRows(candidate, queries, cacheEntries, decision) {
    return queries.map((query, index) => {
        const cacheEntry = cacheEntries[index];
        const body = cacheEntry?.body || {};
        return {
            'Candidate ID': candidate.id,
            'Display Name': candidate.displayName,
            'Query Label': query.label,
            'Query URL': cacheEntry?.url || buildNppesUrl(query.params).toString(),
            'HTTP Status': String(cacheEntry?.status || ''),
            'Result Count': String(body.result_count ?? 0),
            'Errors': Array.isArray(body.Errors) ? body.Errors.map(error => error.description || JSON.stringify(error)).join('; ') : '',
            'Selected NPI': decision.result?.number || '',
            'Match Status': decision.status,
            'Confidence': decision.confidence,
            'Score': String(decision.score),
            'Fetched At': cacheEntry?.fetchedAt || ''
        };
    });
}

function applySharedMailingFlags(enrichedRows) {
    const counts = new Map();
    for (const row of enrichedRows) {
        const key = [
            row['Mailing Address 1'],
            row['Mailing City'],
            row['Mailing State'],
            String(row['Mailing ZIP'] || '').slice(0, 5)
        ].map(value => String(value || '').trim().toUpperCase()).join('|');
        if (key.replace(/\|/g, '') !== '') counts.set(key, (counts.get(key) || 0) + 1);
    }

    for (const row of enrichedRows) {
        const key = [
            row['Mailing Address 1'],
            row['Mailing City'],
            row['Mailing State'],
            String(row['Mailing ZIP'] || '').slice(0, 5)
        ].map(value => String(value || '').trim().toUpperCase()).join('|');
        const sharedCount = counts.get(key) || 0;
        row['Shared Mailing Address Count'] = String(sharedCount || '');
        if (sharedCount >= 3) {
            row['Generic Mailing Address Flag'] = 'Shared by multiple providers';
        }
    }
}

function reviewQueueRows(enrichedRows) {
    return enrichedRows.filter(row => {
        return row['Match Status'] !== 'Matched'
            || row.Confidence !== 'high'
            || row['Generic Mailing Address Flag'] !== 'No'
            || row['Multiple Practice Locations'] === 'Yes'
            || row['Source Matched Mailing Instead Of Practice'] === 'Yes';
    });
}

function finalHumanReviewRows(enrichedRows) {
    return enrichedRows.filter(row => row['Final Human Review Needed'] === 'Yes');
}

async function main() {
    const args = parseArgs(process.argv);
    if (!fs.existsSync(args.input)) {
        throw new Error(`Input CSV not found: ${args.input}`);
    }
    if (typeof fetch !== 'function') {
        throw new Error('This script requires a Node runtime with global fetch support.');
    }

    const outputDir = path.join(args.outputRoot, timestampForPath());
    fs.mkdirSync(outputDir, { recursive: true });

    const rawCsv = fs.readFileSync(args.input, 'utf8').replace(/^\uFEFF/, '');
    const rawRows = parseCsv(rawCsv);
    const allCandidates = normalizePcpRows(rawRows);
    const candidates = args.maxCandidates > 0 ? allCandidates.slice(0, args.maxCandidates) : allCandidates;
    const cachePath = path.join(args.outputRoot, 'nppes-cache.json');
    const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};

    const normalizedRows = allCandidates.map(normalizedGroupRow);
    const enrichedRows = [];
    const providerLocationRows = [];
    const sourceRows = [];

    for (const [index, candidate] of candidates.entries()) {
        const queries = buildNppesQueries(candidate);
        const cacheEntries = [];
        const queryResults = [];

        for (const query of queries) {
            const cacheEntry = await fetchNppes(query.params, cache, args.delayMs);
            cacheEntries.push(cacheEntry);
            if (Array.isArray(cacheEntry.body?.results)) {
                queryResults.push(...cacheEntry.body.results);
            }
        }

        const decision = selectBestMatch(candidate, dedupeResults(queryResults));
        enrichedRows.push(formatEnrichedDirectoryRow(candidate, decision));
        providerLocationRows.push(...formatProviderLocationRows(candidate, decision));
        sourceRows.push(...sourceLogRows(candidate, queries, cacheEntries, decision));

        if ((index + 1) % 25 === 0 || index + 1 === candidates.length) {
            fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
            console.log(`Processed ${index + 1}/${candidates.length} candidates`);
        }
    }

    applySharedMailingFlags(enrichedRows);
    for (let i = 0; i < enrichedRows.length; i += 1) {
        enrichedRows[i] = verifyEnrichedDirectoryRow(enrichedRows[i]);
    }
    const reviewRows = reviewQueueRows(enrichedRows);
    const finalReviewRows = finalHumanReviewRows(enrichedRows);
    const summary = {
        inputCsv: args.input,
        outputDir,
        rawRowCount: rawRows.length,
        normalizedCandidateCount: allCandidates.length,
        processedCandidateCount: candidates.length,
        enrichedRowCount: enrichedRows.length,
        matchedCount: enrichedRows.filter(row => row['Match Status'] === 'Matched').length,
        highConfidenceCount: enrichedRows.filter(row => row.Confidence === 'high').length,
        reviewQueueCount: reviewRows.length,
        verifiedIdentityCount: enrichedRows.filter(row => String(row['Verification Status']).startsWith('Verified')).length,
        finalHumanReviewCount: finalReviewRows.length,
        generatedAt: new Date().toISOString()
    };

    const rawHeaders = ['PCP/Pediatrician Name', 'PCP Phone Number:', 'PCP Fax:'];
    const normalizedHeaders = Object.keys(normalizedRows[0] || {});
    const enrichedHeaders = Object.keys(enrichedRows[0] || {});
    const locationHeaders = Object.keys(providerLocationRows[0] || {
        'Candidate ID': '',
        NPI: '',
        'Provider Name': '',
        'Location Index': '',
        'Address Purpose': '',
        'Address 1': '',
        'Address 2': '',
        City: '',
        State: '',
        ZIP: '',
        Phone: '',
        Fax: ''
    });
    const sourceHeaders = Object.keys(sourceRows[0] || {});

    fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(outputDir, 'enriched-pcp-directory.json'), JSON.stringify(enrichedRows, null, 2));
    fs.writeFileSync(path.join(outputDir, 'provider-locations.json'), JSON.stringify(providerLocationRows, null, 2));
    writeCsv(path.join(outputDir, 'raw-export.csv'), rawRows, rawHeaders);
    writeCsv(path.join(outputDir, 'normalized-groups.csv'), normalizedRows, normalizedHeaders);
    writeCsv(path.join(outputDir, 'enriched-pcp-directory.csv'), enrichedRows, enrichedHeaders);
    writeCsv(path.join(outputDir, 'provider-locations.csv'), providerLocationRows, locationHeaders);
    writeCsv(path.join(outputDir, 'review-queue.csv'), reviewRows, enrichedHeaders);
    writeCsv(path.join(outputDir, 'final-human-review.csv'), finalReviewRows, enrichedHeaders);
    writeCsv(path.join(outputDir, 'source-log.csv'), sourceRows, sourceHeaders);
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));

    console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = {
    parseCsv,
    csvEscape,
    neutralizeSpreadsheetFormula,
    writeCsv,
    reviewQueueRows,
    finalHumanReviewRows,
    applySharedMailingFlags
};

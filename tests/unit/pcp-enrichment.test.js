const test = require('node:test');
const assert = require('node:assert');

const {
    normalizePcpRows,
    classifyProviderCandidate,
    buildNppesQueries,
    scoreNppesMatch,
    selectBestMatch,
    formatEnrichedDirectoryRow,
    formatProviderLocationRows,
    verifyEnrichedDirectoryRow,
    normalizeDigits,
    formatPhone
} = require('../../lib/pcp-enrichment');

function abbyHefnerResult() {
    return {
        number: '1043242522',
        enumeration_type: 'NPI-1',
        basic: {
            first_name: 'ABBY',
            middle_name: 'C',
            last_name: 'HEFNER',
            credential: 'ARNP',
            status: 'A'
        },
        addresses: [
            {
                address_purpose: 'LOCATION',
                address_1: '1023 NEW MOODY LN STE 201',
                city: 'LA GRANGE',
                state: 'KY',
                postal_code: '400319181',
                telephone_number: '502-225-5520'
            },
            {
                address_purpose: 'MAILING',
                address_1: '5200 COMMERCE CROSSINGS DR FL 3',
                city: 'LOUISVILLE',
                state: 'KY',
                postal_code: '402292182',
                telephone_number: '502-253-4924',
                fax_number: '502-489-5750'
            }
        ],
        taxonomies: [
            {
                primary: true,
                desc: 'Nurse Practitioner',
                state: 'KY'
            }
        ]
    };
}

function eastLouisvillePediatricsResult() {
    return {
        number: '1699792465',
        enumeration_type: 'NPI-2',
        basic: {
            organization_name: 'EAST LOUISVILLE PEDIATRICS, P.S.C.',
            status: 'A'
        },
        other_names: [
            {
                organization_name: 'EAST LOUISVILLE PEDIATRICS',
                type: 'Doing Business As'
            }
        ],
        addresses: [
            {
                address_purpose: 'LOCATION',
                address_1: '4171 WESTPORT RD',
                city: 'LOUISVILLE',
                state: 'KY',
                postal_code: '402072739',
                telephone_number: '502-896-8868',
                fax_number: '502-895-6278'
            },
            {
                address_purpose: 'MAILING',
                address_1: '4171 WESTPORT RD',
                city: 'LOUISVILLE',
                state: 'KY',
                postal_code: '402072739',
                telephone_number: '502-721-0012',
                fax_number: '502-895-6278'
            }
        ],
        taxonomies: [
            {
                primary: true,
                desc: 'Pediatrics'
            }
        ]
    };
}

test('normalizes duplicate PCP export rows into provider candidates', () => {
    const candidates = normalizePcpRows([
        {
            'PCP/Pediatrician Name': 'Abby Hefner',
            'PCP Phone Number:': '(502) 225-5520',
            'PCP Fax:': ''
        },
        {
            'PCP/Pediatrician Name': 'Abby Hefner NP',
            'PCP Phone Number:': '(502) 225-520',
            'PCP Fax:': '502-225-5522'
        }
    ]);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].firstName, 'Abby');
    assert.equal(candidates[0].lastName, 'Hefner');
    assert.equal(candidates[0].credential, 'NP');
    assert.equal(candidates[0].rawRowCount, 2);
    assert.deepEqual(candidates[0].sourcePhones, ['5022255520']);
    assert.deepEqual(candidates[0].sourceFaxes, ['5022255522']);
    assert.match(candidates[0].reviewReasons.join('; '), /Invalid source phone/);
});

test('classifies practice names separately from individual clinicians', () => {
    const [practice, clinician] = normalizePcpRows([
        {
            'PCP/Pediatrician Name': 'East Louisville Pediatrics',
            'PCP Phone Number:': '(502) 896-8868',
            'PCP Fax:': ''
        },
        {
            'PCP/Pediatrician Name': 'Abigail Lawson',
            'PCP Phone Number:': '(502) 426-4264',
            'PCP Fax:': ''
        }
    ]);

    assert.equal(classifyProviderCandidate(practice), 'organization');
    assert.equal(classifyProviderCandidate(clinician), 'individual');
});

test('builds NPPES queries for individual and organization provider types', () => {
    const [practice, clinician] = normalizePcpRows([
        {
            'PCP/Pediatrician Name': 'East Louisville Pediatrics',
            'PCP Phone Number:': '(502) 896-8868',
            'PCP Fax:': ''
        },
        {
            'PCP/Pediatrician Name': 'Abigail Lawson',
            'PCP Phone Number:': '(502) 426-4264',
            'PCP Fax:': ''
        }
    ]);

    assert.equal(buildNppesQueries(practice)[0].params.enumeration_type, 'NPI-2');
    assert.equal(buildNppesQueries(practice)[0].params.organization_name, 'East Louisville Pediatrics');
    assert.equal(buildNppesQueries(practice).some(query => query.params.enumeration_type === 'NPI-1'), false);
    assert.equal(buildNppesQueries(clinician)[0].params.enumeration_type, 'NPI-1');
    assert.equal(buildNppesQueries(clinician)[0].params.first_name, 'Abigail');
    assert.equal(buildNppesQueries(clinician)[0].params.last_name, 'Lawson');
});

test('facility shorthand generates Type 2 wildcard organization queries', () => {
    const [candidate] = normalizePcpRows([
        {
            'PCP/Pediatrician Name': 'Amins family',
            'PCP Phone Number:': '(502) 637-1005',
            'PCP Fax:': ''
        }
    ]);
    const queries = buildNppesQueries(candidate);

    assert.equal(candidate.providerKind, 'organization');
    assert.equal(queries.every(query => query.params.enumeration_type === 'NPI-2'), true);
    assert.ok(queries.some(query => query.params.organization_name === 'Amin*'));
});

test('scores and selects a high-confidence NPPES match using name, phone, status, and taxonomy', () => {
    const [candidate] = normalizePcpRows([
        {
            'PCP/Pediatrician Name': 'Abby Hefner',
            'PCP Phone Number:': '(502) 225-5520',
            'PCP Fax:': ''
        }
    ]);

    const score = scoreNppesMatch(candidate, abbyHefnerResult());
    const decision = selectBestMatch(candidate, [abbyHefnerResult()]);

    assert.ok(score.score >= 80);
    assert.equal(decision.status, 'Matched');
    assert.equal(decision.confidence, 'high');
    assert.equal(decision.practiceAddress.address_purpose, 'LOCATION');
    assert.equal(decision.mailingAddress.address_purpose, 'MAILING');
});

test('formats enriched rows without mixing location and mailing address fields', () => {
    const [candidate] = normalizePcpRows([
        {
            'PCP/Pediatrician Name': 'Abby Hefner NP',
            'PCP Phone Number:': '(502) 225-5520',
            'PCP Fax:': ''
        }
    ]);
    const decision = selectBestMatch(candidate, [abbyHefnerResult()]);
    const row = formatEnrichedDirectoryRow(candidate, decision);
    const locations = formatProviderLocationRows(candidate, decision);

    assert.equal(row['First Name'], 'Abby');
    assert.equal(row['Last Name'], 'Hefner');
    assert.equal(row.Credential, 'ARNP');
    assert.equal(row.Phone, '1 (502) 225-5520');
    assert.equal(row['Practice Address 1'], '1023 NEW MOODY LN STE 201');
    assert.equal(row['Mailing Address 1'], '5200 COMMERCE CROSSINGS DR FL 3');
    assert.equal(row['Mailing Differs From Practice'], 'Yes');
    assert.equal(locations.length, 2);
});

test('organization match uses DBA name and organization NPI', () => {
    const [candidate] = normalizePcpRows([
        {
            'PCP/Pediatrician Name': 'East Louisville Pediatrics',
            'PCP Phone Number:': '(502) 896-8868',
            'PCP Fax:': ''
        }
    ]);
    const decision = selectBestMatch(candidate, [eastLouisvillePediatricsResult()]);
    const row = formatEnrichedDirectoryRow(candidate, decision);

    assert.equal(decision.status, 'Matched');
    assert.equal(row.NPI, '1699792465');
    assert.equal(row['Provider Kind'], 'organization');
    assert.equal(row['NPI Type'], 'Type 2 Organization');
    assert.equal(row['Organization Name'], 'EAST LOUISVILLE PEDIATRICS, P.S.C.');
    assert.equal(row['First Name'], '');
    assert.equal(row['Last Name'], '');
    assert.equal(row.Phone, '1 (502) 896-8868');
    assert.equal(row['Practice Address Purpose'], 'LOCATION');
    assert.equal(row['Mailing Address Purpose'], 'MAILING');
});

test('facility shorthand can select a Type 2 organization NPI by wildcard and phone', () => {
    const [candidate] = normalizePcpRows([
        {
            'PCP/Pediatrician Name': 'Amins family',
            'PCP Phone Number:': '(502) 637-1005',
            'PCP Fax:': ''
        }
    ]);
    const result = {
        number: '1750307393',
        enumeration_type: 'NPI-2',
        basic: {
            organization_name: "AMIN'S FAMILY PRACTICE ASSOCIATES , PSC",
            status: 'A'
        },
        addresses: [
            {
                address_purpose: 'MAILING',
                address_1: '1505 S 7TH ST',
                city: 'LOUISVILLE',
                state: 'KY',
                postal_code: '402081710',
                telephone_number: '502-637-1005',
                fax_number: '502-635-0046'
            },
            {
                address_purpose: 'LOCATION',
                address_1: '1505 S 7TH ST',
                city: 'LOUISVILLE',
                state: 'KY',
                postal_code: '402081710',
                telephone_number: '502-637-1005',
                fax_number: '502-635-0046'
            }
        ],
        taxonomies: [
            {
                primary: true,
                desc: 'Family Medicine'
            }
        ]
    };
    const decision = selectBestMatch(candidate, [result]);
    const row = formatEnrichedDirectoryRow(candidate, decision);

    assert.equal(decision.status, 'Matched');
    assert.equal(decision.confidence, 'high');
    assert.equal(row.NPI, '1750307393');
    assert.equal(row['NPI Type'], 'Type 2 Organization');
    assert.equal(row['Organization Name'], "AMIN'S FAMILY PRACTICE ASSOCIATES , PSC");
    assert.equal(row['First Name'], '');
    assert.equal(row['Last Name'], '');
    assert.equal(row['Provider Kind'], 'organization');
    assert.equal(row['Practice Address Purpose'], 'LOCATION');
});

test('weak organization wildcard results do not populate unrelated facility NPIs', () => {
    const [candidate] = normalizePcpRows([
        {
            'PCP/Pediatrician Name': 'All Star Pediatrics',
            'PCP Phone Number:': '(502) 762-0498',
            'PCP Fax:': ''
        }
    ]);
    const unrelatedResult = {
        number: '1346466224',
        enumeration_type: 'NPI-2',
        basic: {
            organization_name: 'ALL ABOUT FAMILIES, PLLC',
            status: 'A'
        },
        addresses: [
            {
                address_purpose: 'LOCATION',
                address_1: '7410 NEW LAGRANGE RD',
                city: 'LOUISVILLE',
                state: 'KY',
                postal_code: '402224858',
                telephone_number: '502-429-0876',
                fax_number: '502-891-2613'
            }
        ],
        taxonomies: [
            {
                primary: true,
                desc: 'Physical Therapist, Pediatrics'
            }
        ]
    };
    const decision = selectBestMatch(candidate, [unrelatedResult]);
    const row = formatEnrichedDirectoryRow(candidate, decision);

    assert.equal(decision.status, 'No Match');
    assert.equal(row.NPI, '');
    assert.equal(row['First Name'], '');
    assert.equal(row['Last Name'], '');
    assert.match(row['Review Reason'], /none had name or contact evidence/);
});

test('normalizes phone digits and display formatting', () => {
    assert.equal(normalizeDigits('+1 (502) 426-4264'), '5024264264');
    assert.equal(formatPhone('5024264264'), '1 (502) 426-4264');
    assert.equal(formatPhone('3232'), '3232');
});

test('verification rules accept high-confidence individual matches', () => {
    const [candidate] = normalizePcpRows([
        {
            'PCP/Pediatrician Name': 'Abby Hefner',
            'PCP Phone Number:': '(502) 225-5520',
            'PCP Fax:': ''
        }
    ]);
    const row = verifyEnrichedDirectoryRow(formatEnrichedDirectoryRow(candidate, selectBestMatch(candidate, [abbyHefnerResult()])));

    assert.equal(row['Verification Status'], 'Verified - Individual');
    assert.equal(row['Verified Entity Type'], 'Individual clinician');
    assert.equal(row['Final Human Review Needed'], 'No');
});

test('verification rules accept high-confidence facility matches', () => {
    const [candidate] = normalizePcpRows([
        {
            'PCP/Pediatrician Name': 'Amins family',
            'PCP Phone Number:': '(502) 637-1005',
            'PCP Fax:': ''
        }
    ]);
    const result = {
        number: '1750307393',
        enumeration_type: 'NPI-2',
        basic: {
            organization_name: "AMIN'S FAMILY PRACTICE ASSOCIATES , PSC",
            status: 'A'
        },
        addresses: [
            {
                address_purpose: 'LOCATION',
                address_1: '1505 S 7TH ST',
                city: 'LOUISVILLE',
                state: 'KY',
                postal_code: '402081710',
                telephone_number: '502-637-1005',
                fax_number: '502-635-0046'
            },
            {
                address_purpose: 'MAILING',
                address_1: '1505 S 7TH ST',
                city: 'LOUISVILLE',
                state: 'KY',
                postal_code: '402081710',
                telephone_number: '502-637-1005',
                fax_number: '502-635-0046'
            }
        ],
        taxonomies: [{ primary: true, desc: 'Family Medicine' }]
    };
    const row = verifyEnrichedDirectoryRow(formatEnrichedDirectoryRow(candidate, selectBestMatch(candidate, [result])));

    assert.equal(row['Verification Status'], 'Verified - Facility');
    assert.equal(row['Verified Entity Type'], 'Facility/practice');
    assert.equal(row['Final Human Review Needed'], 'No');
});

test('verification rules keep weak rejected candidates in final human review', () => {
    const row = verifyEnrichedDirectoryRow({
        'Source Display Name': 'All Star Pediatrics',
        Phone: '1 (502) 762-0498',
        NPI: '',
        'NPI Type': '',
        'Provider Kind': 'organization',
        'Match Status': 'No Match',
        Confidence: 'none',
        'Match Basis': 'organization provider type; Kentucky address',
        'Review Reason': 'NPPES results found but none had name or contact evidence',
        'Generic Mailing Address Flag': 'No',
        'Multiple Practice Locations': 'No',
        'Source Matched Mailing Instead Of Practice': 'No',
        'Mailing Differs From Practice': 'No'
    });

    assert.equal(row['Verification Status'], 'Rejected API Candidate');
    assert.equal(row['Final Human Review Needed'], 'Yes');
    assert.match(row['Internet Search Query'], /All Star Pediatrics/);
});

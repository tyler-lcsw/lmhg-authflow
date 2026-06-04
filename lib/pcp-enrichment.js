const ORGANIZATION_TERMS = [
    'associates',
    'clinic',
    'center',
    'children',
    'childrens',
    'family',
    'family health',
    'group',
    'health',
    'healthcare',
    'hospital',
    'medical',
    'pediatric',
    'pediatrics',
    'practice',
    'primary care'
];

const CREDENTIAL_TERMS = [
    'MD',
    'M.D.',
    'DO',
    'D.O.',
    'NP',
    'APRN',
    'ARNP',
    'PA',
    'PA-C',
    'FNP',
    'DNP',
    'PHD'
];

const TITLE_TERMS = ['DR', 'DR.', 'MR', 'MR.', 'MS', 'MS.', 'MRS', 'MRS.'];

const PCP_TAXONOMY_TERMS = [
    'family medicine',
    'general practice',
    'internal medicine',
    'nurse practitioner',
    'pediatrics',
    'physician assistant',
    'primary care'
];

/**
 * @typedef {Object} RawPcpRow
 * @property {string} [PCP/Pediatrician Name]
 * @property {string} [PCP Phone Number:]
 * @property {string} [PCP Fax:]
 */

/**
 * @typedef {Object} NormalizedPcpCandidate
 * @property {string} id
 * @property {string} displayName
 * @property {string} normalizedName
 * @property {string} firstName
 * @property {string} lastName
 * @property {string} title
 * @property {string} credential
 * @property {string} providerKind
 * @property {string[]} rawNames
 * @property {string[]} sourcePhones
 * @property {string[]} sourceFaxes
 * @property {number} rawRowCount
 * @property {string[]} reviewReasons
 */

/**
 * @typedef {Object} NppesProviderResult
 * @property {string} number
 * @property {string} enumeration_type
 * @property {Object} basic
 * @property {Object[]} addresses
 * @property {Object[]} taxonomies
 * @property {Object[]} [practiceLocations]
 * @property {Object[]} [other_names]
 */

/**
 * @typedef {Object} ProviderMatchDecision
 * @property {NppesProviderResult|null} result
 * @property {number} score
 * @property {string} confidence
 * @property {string} status
 * @property {string[]} basis
 * @property {string[]} reviewReasons
 * @property {number} candidateCount
 * @property {Object|null} practiceAddress
 * @property {Object|null} mailingAddress
 * @property {boolean} multiplePracticeLocations
 */

/**
 * @typedef {Object} EnrichedPcpRow
 * @property {string} First Name
 * @property {string} Last Name
 * @property {string} Title
 * @property {string} Credential
 * @property {string} Phone
 * @property {string} Fax
 * @property {string} NPI
 */

/**
 * @typedef {Object} ProviderLocationRow
 * @property {string} NPI
 * @property {string} Address Purpose
 * @property {string} Address 1
 * @property {string} Address 2
 * @property {string} City
 * @property {string} State
 * @property {string} ZIP
 */

function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeAsciiApostrophes(value) {
    return String(value || '').replace(/[’‘]/g, "'");
}

function normalizeDigits(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
    return digits;
}

function formatPhone(value) {
    const digits = normalizeDigits(value);
    if (digits.length !== 10) return String(value || '').trim();
    return `1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function normalizeNameForGrouping(value) {
    let normalized = normalizeAsciiApostrophes(value).toLowerCase();
    normalized = normalized.replace(/'/g, '');
    normalized = normalized.replace(/\b(dr\.?|mr\.?|ms\.?|mrs\.?)\b/g, ' ');
    normalized = normalized.replace(/\b(md|m\.d\.?|do|d\.o\.?|np|aprn|arnp|pa-c|pa|fnp|dnp|phd)\b/g, ' ');
    normalized = normalized.replace(/[^a-z0-9' ]+/g, ' ');
    normalized = normalized.replace(/\bpcp\b|\bpediatrician\b/g, ' ');
    return normalizeWhitespace(normalized);
}

function properCase(value) {
    return normalizeWhitespace(value).toLowerCase().replace(/\b[a-z]/g, match => match.toUpperCase());
}

function uniqueSorted(values) {
    return [...new Set(values.filter(value => normalizeWhitespace(value) !== '').map(normalizeWhitespace))].sort((a, b) => a.localeCompare(b));
}

function mostFrequent(values) {
    const counts = new Map();
    for (const value of values.filter(Boolean)) {
        counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '';
}

function extractTitleAndCredential(rawName) {
    const tokens = normalizeWhitespace(rawName).split(/\s+/);
    let title = '';
    let credential = '';
    const remaining = [];

    for (const token of tokens) {
        const clean = token.replace(/[,]/g, '').toUpperCase();
        if (!title && TITLE_TERMS.includes(clean)) {
            title = clean.replace('.', '') === 'DR' ? 'Dr.' : `${properCase(clean.replace('.', ''))}.`;
            continue;
        }
        if (CREDENTIAL_TERMS.includes(clean)) {
            credential = credential || clean.replace(/\.$/, '');
            continue;
        }
        remaining.push(token);
    }

    return {
        title,
        credential,
        nameWithoutDecorators: normalizeWhitespace(remaining.join(' '))
    };
}

function parsePersonName(rawName) {
    const { title, credential, nameWithoutDecorators } = extractTitleAndCredential(rawName);
    const cleaned = normalizeWhitespace(nameWithoutDecorators.replace(/[,]/g, ' '));
    const parts = cleaned.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
        return { firstName: '', lastName: '', title, credential };
    }
    return {
        firstName: properCase(parts[0]),
        lastName: properCase(parts[parts.length - 1]),
        title,
        credential
    };
}

function credentialFromRawNames(rawNames) {
    for (const rawName of rawNames) {
        const parsed = extractTitleAndCredential(rawName);
        if (parsed.credential) return parsed.credential;
    }
    return '';
}

function titleFromRawNames(rawNames) {
    for (const rawName of rawNames) {
        const parsed = extractTitleAndCredential(rawName);
        if (parsed.title) return parsed.title;
    }
    return '';
}

function looksLikeOrganization(name) {
    const normalized = normalizeNameForGrouping(name);
    return ORGANIZATION_TERMS.some(term => normalized.includes(term));
}

function groupIdFromName(name) {
    return normalizeNameForGrouping(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unnamed';
}

function rawValue(row, key) {
    return normalizeWhitespace(row[key]);
}

function normalizePcpRows(rows) {
    const groups = new Map();

    rows.forEach((row, index) => {
        const rawName = rawValue(row, 'PCP/Pediatrician Name');
        const rawPhone = rawValue(row, 'PCP Phone Number:');
        const rawFax = rawValue(row, 'PCP Fax:');
        const normalizedName = normalizeNameForGrouping(rawName);
        const key = normalizedName || `row-${index + 1}`;

        if (!groups.has(key)) {
            groups.set(key, {
                rows: [],
                rawNames: [],
                rawPhones: [],
                rawFaxes: []
            });
        }

        const group = groups.get(key);
        group.rows.push(row);
        group.rawNames.push(rawName);
        group.rawPhones.push(rawPhone);
        group.rawFaxes.push(rawFax);
    });

    return [...groups.entries()].map(([key, group], index) => {
        const rawNames = uniqueSorted(group.rawNames);
        const sourcePhones = uniqueSorted(group.rawPhones.map(normalizeDigits).filter(digits => digits.length === 10));
        const sourceFaxes = uniqueSorted(group.rawFaxes.map(normalizeDigits).filter(digits => digits.length === 10));
        const displayName = mostFrequent(group.rawNames) || rawNames[0] || '';
        const parsed = parsePersonName(displayName);
        const candidate = {
            id: `${String(index + 1).padStart(4, '0')}-${groupIdFromName(key)}`,
            displayName,
            normalizedName: key,
            firstName: parsed.firstName,
            lastName: parsed.lastName,
            title: parsed.title || titleFromRawNames(rawNames),
            credential: parsed.credential || credentialFromRawNames(rawNames),
            providerKind: 'unknown',
            rawNames,
            sourcePhones,
            sourceFaxes,
            rawRowCount: group.rows.length,
            reviewReasons: []
        };

        candidate.providerKind = classifyProviderCandidate(candidate);

        for (const phone of uniqueSorted(group.rawPhones.map(normalizeDigits).filter(Boolean))) {
            if (phone.length !== 10) candidate.reviewReasons.push(`Invalid source phone: ${phone}`);
        }
        for (const fax of uniqueSorted(group.rawFaxes.map(normalizeDigits).filter(Boolean))) {
            if (fax.length !== 10) candidate.reviewReasons.push(`Invalid source fax: ${fax}`);
        }
        if (!candidate.firstName || !candidate.lastName) {
            candidate.reviewReasons.push('Name is not parseable as first/last individual provider');
        }
        if (candidate.providerKind === 'organization') {
            candidate.reviewReasons.push('Source appears to be a practice or organization');
        }

        return candidate;
    });
}

function classifyProviderCandidate(candidate) {
    if (looksLikeOrganization(candidate.displayName)) return 'organization';
    if (!candidate.firstName || !candidate.lastName) return 'ambiguous';
    return 'individual';
}

function sourceStatesForCandidate(candidate) {
    const states = ['KY'];
    if (candidate.sourcePhones.some(phone => phone.startsWith('812'))) states.push('IN');
    return states;
}

function organizationNameVariants(candidate) {
    const variants = new Set([candidate.displayName]);
    const normalized = normalizeNameForGrouping(candidate.displayName);
    const tokens = normalized.split(/\s+/).filter(Boolean);

    if (tokens.length > 0) {
        variants.add(`${properCase(tokens[0])}*`);
    }
    if (tokens.length > 1) {
        variants.add(`${tokens.slice(0, 2).map(properCase).join(' ')}*`);
    }
    if (tokens.includes('family')) {
        const base = tokens[0]?.replace(/s$/, '');
        if (base && base.length >= 2) {
            variants.add(`${properCase(base)}*`);
            variants.add(`${properCase(base)} Family*`);
            variants.add(`${properCase(base)} Family Practice*`);
        }
    }

    return [...variants].filter(value => normalizeWhitespace(value).length >= 2);
}

function buildNppesQueries(candidate) {
    const queries = [];
    const states = sourceStatesForCandidate(candidate);
    if (candidate.providerKind === 'organization' || candidate.providerKind === 'ambiguous') {
        for (const state of states) {
            for (const organizationName of organizationNameVariants(candidate)) {
                queries.push({
                    label: `organization:${state}:${organizationName}`,
                    params: {
                        version: '2.1',
                        enumeration_type: 'NPI-2',
                        organization_name: organizationName,
                        state,
                        limit: '20'
                    }
                });
            }
        }
    }

    if (candidate.providerKind !== 'organization' && candidate.firstName && candidate.lastName) {
        for (const state of states) {
            queries.push({
                label: `individual:${state}`,
                params: {
                    version: '2.1',
                    enumeration_type: 'NPI-1',
                    first_name: candidate.firstName,
                    last_name: candidate.lastName,
                    state,
                    limit: '20'
                }
            });
        }
    }
    return queries;
}

function providerDisplayName(result) {
    if (!result) return '';
    if (result.enumeration_type === 'NPI-2') {
        return normalizeWhitespace(result.basic?.organization_name || '');
    }
    return normalizeWhitespace([result.basic?.first_name, result.basic?.middle_name, result.basic?.last_name].filter(Boolean).join(' '));
}

function resultSearchNames(result) {
    const names = [providerDisplayName(result)];
    if (Array.isArray(result.other_names)) {
        for (const other of result.other_names) {
            if (other.organization_name) names.push(other.organization_name);
            if (other.first_name || other.last_name) {
                names.push([other.first_name, other.last_name].filter(Boolean).join(' '));
            }
        }
    }
    return uniqueSorted(names.map(normalizeNameForGrouping));
}

function firstLastMatch(candidate, result) {
    if (result?.enumeration_type !== 'NPI-1') return false;
    const firstName = normalizeNameForGrouping(result.basic?.first_name || '');
    const lastName = normalizeNameForGrouping(result.basic?.last_name || '');
    return firstName === normalizeNameForGrouping(candidate.firstName)
        && lastName === normalizeNameForGrouping(candidate.lastName);
}

function allAddresses(result) {
    const addresses = Array.isArray(result?.addresses) ? result.addresses : [];
    const practiceLocations = Array.isArray(result?.practiceLocations)
        ? result.practiceLocations.map(location => ({ ...location, address_purpose: location.address_purpose || 'PRACTICE_LOCATION' }))
        : [];
    return [...addresses, ...practiceLocations];
}

function addressPhoneDigits(address) {
    return normalizeDigits(address?.telephone_number || address?.phone || '');
}

function addressFaxDigits(address) {
    return normalizeDigits(address?.fax_number || address?.fax || '');
}

function anyAddressPhoneMatches(candidate, result) {
    const phones = new Set(candidate.sourcePhones);
    return allAddresses(result).some(address => phones.has(addressPhoneDigits(address)));
}

function sourcePhoneMatchesPurpose(candidate, result, purpose) {
    const phones = new Set(candidate.sourcePhones);
    return allAddresses(result)
        .filter(address => String(address.address_purpose || '').toUpperCase() === purpose)
        .some(address => phones.has(addressPhoneDigits(address)));
}

function anyAddressFaxMatches(candidate, result) {
    const faxes = new Set(candidate.sourceFaxes);
    return allAddresses(result).some(address => faxes.has(addressFaxDigits(address)));
}

function primaryTaxonomy(result) {
    const taxonomies = Array.isArray(result?.taxonomies) ? result.taxonomies : [];
    return taxonomies.find(taxonomy => taxonomy.primary) || taxonomies[0] || null;
}

function scoreNppesMatch(candidate, result) {
    let score = 0;
    const basis = [];
    const candidateName = normalizeNameForGrouping(candidate.displayName);
    const resultNames = resultSearchNames(result);

    if (resultNames.includes(candidateName) || firstLastMatch(candidate, result)) {
        score += 45;
        basis.push('exact normalized name');
    } else if (resultNames.some(name => name.includes(candidateName) || candidateName.includes(name))) {
        score += 30;
        basis.push('partial normalized name');
    }

    if (candidate.providerKind === 'organization' && result.enumeration_type === 'NPI-2') {
        score += 15;
        basis.push('organization provider type');
    }
    if (candidate.providerKind === 'individual' && result.enumeration_type === 'NPI-1') {
        score += 15;
        basis.push('individual provider type');
    }
    if (anyAddressPhoneMatches(candidate, result)) {
        score += 30;
        basis.push('source phone matched NPPES address');
    }
    if (sourcePhoneMatchesPurpose(candidate, result, 'LOCATION') && sourcePhoneMatchesPurpose(candidate, result, 'MAILING')) {
        score += 12;
        basis.push('source phone matched both location and mailing address');
    }
    if (anyAddressFaxMatches(candidate, result)) {
        score += 20;
        basis.push('source fax matched NPPES address');
    }
    if (allAddresses(result).some(address => address.state === 'KY')) {
        score += 8;
        basis.push('Kentucky address');
    }
    if (pickAddress(result, 'LOCATION', candidate)?.state === 'KY' && pickAddress(result, 'MAILING', candidate)?.state === 'KY') {
        score += 6;
        basis.push('Kentucky location and mailing addresses');
    }
    if (result.basic?.status === 'A') {
        score += 6;
        basis.push('active NPI');
    }

    const taxonomy = primaryTaxonomy(result);
    const taxonomyDesc = String(taxonomy?.desc || '').toLowerCase();
    if (PCP_TAXONOMY_TERMS.some(term => taxonomyDesc.includes(term))) {
        score += 8;
        basis.push(`primary care taxonomy: ${taxonomy?.desc}`);
    }

    return { score, basis };
}

function pickAddress(result, purpose, candidate) {
    const addresses = allAddresses(result).filter(address => String(address.address_purpose || '').toUpperCase() === purpose);
    if (!addresses.length) return null;

    const phones = new Set(candidate.sourcePhones);
    const faxes = new Set(candidate.sourceFaxes);
    return addresses.find(address => phones.has(addressPhoneDigits(address)))
        || addresses.find(address => faxes.has(addressFaxDigits(address)))
        || addresses[0];
}

function hasMultiplePracticeLocations(result) {
    const locations = allAddresses(result).filter(address => {
        const purpose = String(address.address_purpose || '').toUpperCase();
        return purpose === 'LOCATION' || purpose === 'PRACTICE_LOCATION';
    });
    const keys = new Set(locations.map(addressKey).filter(Boolean));
    return keys.size > 1;
}

function addressKey(address) {
    if (!address) return '';
    return [
        address.address_1,
        address.address_2,
        address.city,
        address.state,
        String(address.postal_code || '').slice(0, 5)
    ].map(value => normalizeWhitespace(value).toUpperCase()).join('|');
}

function selectBestMatch(candidate, results) {
    if (!results.length) {
        return {
            result: null,
            score: 0,
            confidence: 'none',
            status: 'No Match',
            basis: [],
            reviewReasons: ['No NPPES result found'],
            candidateCount: 0,
            practiceAddress: null,
            mailingAddress: null,
            multiplePracticeLocations: false
        };
    }

    const scored = results
        .map(result => ({ result, ...scoreNppesMatch(candidate, result) }))
        .sort((a, b) => b.score - a.score);
    const best = scored[0];
    const second = scored[1];
    const reviewReasons = [...candidate.reviewReasons];
    let confidence = 'low';
    let status = 'Review';
    const hasIdentityEvidence = best.basis.some(item => {
        return item.includes('normalized name') || item.includes('source phone') || item.includes('source fax');
    });

    if (!hasIdentityEvidence) {
        return {
            result: null,
            score: best.score,
            confidence: 'none',
            status: 'No Match',
            basis: best.basis,
            reviewReasons: uniqueSorted([...reviewReasons, 'NPPES results found but none had name or contact evidence']),
            candidateCount: results.length,
            practiceAddress: null,
            mailingAddress: null,
            multiplePracticeLocations: false
        };
    }

    if (best.score >= 80 && (!second || best.score - second.score >= 10)) {
        confidence = 'high';
        status = 'Matched';
    } else if (best.score >= 60 && (!second || best.score - second.score >= 15)) {
        confidence = 'medium';
        status = 'Matched';
        reviewReasons.push('Medium-confidence match should be spot-checked');
    } else {
        reviewReasons.push('Ambiguous or weak NPPES match');
    }

    return {
        result: best.result,
        score: best.score,
        confidence,
        status,
        basis: best.basis,
        reviewReasons: uniqueSorted(reviewReasons),
        candidateCount: results.length,
        practiceAddress: pickAddress(best.result, 'LOCATION', candidate),
        mailingAddress: pickAddress(best.result, 'MAILING', candidate),
        multiplePracticeLocations: hasMultiplePracticeLocations(best.result)
    };
}

function credentialFromResult(result, fallback) {
    return normalizeWhitespace(result?.basic?.credential || fallback || '').replace(/\s+/g, ' ');
}

function titleFromResult(result, fallbackTitle, credential) {
    if (fallbackTitle) return fallbackTitle;
    const cred = String(credential || '').toUpperCase();
    const taxonomy = String(primaryTaxonomy(result)?.desc || '').toLowerCase();
    if (['MD', 'M.D.', 'DO', 'D.O.'].includes(cred) || taxonomy.includes('physician')) return 'Dr.';
    return '';
}

function phoneFromDecision(candidate, decision) {
    const practicePhone = addressPhoneDigits(decision.practiceAddress);
    const mailingPhone = addressPhoneDigits(decision.mailingAddress);
    return practicePhone || candidate.sourcePhones[0] || mailingPhone || '';
}

function faxFromDecision(candidate, decision) {
    const practiceFax = addressFaxDigits(decision.practiceAddress);
    const mailingFax = addressFaxDigits(decision.mailingAddress);
    return practiceFax || candidate.sourceFaxes[0] || mailingFax || '';
}

function addressFields(prefix, address) {
    return {
        [`${prefix} Address 1`]: normalizeWhitespace(address?.address_1),
        [`${prefix} Address 2`]: normalizeWhitespace(address?.address_2),
        [`${prefix} City`]: normalizeWhitespace(address?.city),
        [`${prefix} State`]: normalizeWhitespace(address?.state),
        [`${prefix} ZIP`]: normalizeWhitespace(address?.postal_code)
    };
}

function mailingDiffersFromPractice(decision) {
    return Boolean(decision.practiceAddress && decision.mailingAddress && addressKey(decision.practiceAddress) !== addressKey(decision.mailingAddress));
}

function sourceMatchedMailingInsteadOfPractice(candidate, decision) {
    if (!decision.mailingAddress) return false;
    const phoneMatchedMailing = candidate.sourcePhones.includes(addressPhoneDigits(decision.mailingAddress));
    const faxMatchedMailing = candidate.sourceFaxes.includes(addressFaxDigits(decision.mailingAddress));
    const phoneMatchedPractice = decision.practiceAddress && candidate.sourcePhones.includes(addressPhoneDigits(decision.practiceAddress));
    const faxMatchedPractice = decision.practiceAddress && candidate.sourceFaxes.includes(addressFaxDigits(decision.practiceAddress));
    return (phoneMatchedMailing || faxMatchedMailing) && !(phoneMatchedPractice || faxMatchedPractice);
}

function formatEnrichedDirectoryRow(candidate, decision) {
    const result = decision.result;
    const credential = credentialFromResult(result, candidate.credential);
    const isOrganizationNpi = result?.enumeration_type === 'NPI-2';
    const isOrganizationRow = isOrganizationNpi || candidate.providerKind === 'organization';
    const firstName = isOrganizationRow ? '' : normalizeWhitespace(result?.basic?.first_name ? properCase(result.basic.first_name) : candidate.firstName);
    const lastName = isOrganizationRow ? '' : normalizeWhitespace(result?.basic?.last_name ? properCase(result.basic.last_name) : candidate.lastName);
    const title = isOrganizationRow ? '' : titleFromResult(result, candidate.title, credential);

    return {
        'Candidate ID': candidate.id,
        'Source Display Name': candidate.displayName,
        'First Name': firstName,
        'Last Name': lastName,
        'Organization Name': isOrganizationNpi ? normalizeWhitespace(result?.basic?.organization_name) : '',
        'Title': title,
        'Credential': credential,
        'Phone': formatPhone(phoneFromDecision(candidate, decision)),
        'Fax': formatPhone(faxFromDecision(candidate, decision)),
        'NPI': result?.number || '',
        'NPI Type': result?.enumeration_type === 'NPI-2' ? 'Type 2 Organization' : result?.enumeration_type === 'NPI-1' ? 'Type 1 Individual' : '',
        ...addressFields('Practice', decision.practiceAddress),
        ...addressFields('Mailing', decision.mailingAddress),
        'Provider Kind': candidate.providerKind,
        'Match Status': decision.status,
        'Confidence': decision.confidence,
        'Score': String(decision.score),
        'Match Basis': decision.basis.join('; '),
        'Source': result ? 'NPPES API v2.1' : '',
        'Practice Address Purpose': normalizeWhitespace(decision.practiceAddress?.address_purpose),
        'Mailing Address Purpose': normalizeWhitespace(decision.mailingAddress?.address_purpose),
        'Multiple Practice Locations': decision.multiplePracticeLocations ? 'Yes' : 'No',
        'Generic Mailing Address Flag': mailingDiffersFromPractice(decision) ? 'Review' : 'No',
        'Mailing Differs From Practice': mailingDiffersFromPractice(decision) ? 'Yes' : 'No',
        'Source Matched Mailing Instead Of Practice': sourceMatchedMailingInsteadOfPractice(candidate, decision) ? 'Yes' : 'No',
        'Raw Name Variants': candidate.rawNames.join('; '),
        'Raw Row Count': String(candidate.rawRowCount),
        'Review Reason': decision.reviewReasons.join('; ')
    };
}

function formatProviderLocationRows(candidate, decision) {
    if (!decision.result) return [];
    return allAddresses(decision.result).map((address, index) => ({
        'Candidate ID': candidate.id,
        'NPI': decision.result.number || '',
        'Provider Name': providerDisplayName(decision.result),
        'Location Index': String(index + 1),
        'Address Purpose': normalizeWhitespace(address.address_purpose),
        'Address 1': normalizeWhitespace(address.address_1),
        'Address 2': normalizeWhitespace(address.address_2),
        'City': normalizeWhitespace(address.city),
        'State': normalizeWhitespace(address.state),
        'ZIP': normalizeWhitespace(address.postal_code),
        'Phone': formatPhone(addressPhoneDigits(address)),
        'Fax': formatPhone(addressFaxDigits(address))
    }));
}

function rowText(row, field) {
    return String(row[field] || '');
}

function hasBasis(row, pattern) {
    return rowText(row, 'Match Basis').toLowerCase().includes(pattern);
}

function hasReviewReason(row, pattern) {
    return rowText(row, 'Review Reason').toLowerCase().includes(pattern);
}

function hasAddressWarning(row) {
    return row['Generic Mailing Address Flag'] !== 'No'
        || row['Multiple Practice Locations'] === 'Yes'
        || row['Source Matched Mailing Instead Of Practice'] === 'Yes'
        || row['Mailing Differs From Practice'] === 'Yes';
}

function hasIdentityEvidence(row) {
    return hasBasis(row, 'exact normalized name')
        || hasBasis(row, 'source phone matched')
        || hasBasis(row, 'source fax matched');
}

function buildInternetSearchQuery(row) {
    const quotedName = row['Organization Name'] || row['Source Display Name'] || [row['First Name'], row['Last Name']].filter(Boolean).join(' ');
    const phone = normalizeDigits(row.Phone || '');
    const npi = row.NPI ? ` "${row.NPI}"` : '';
    const phonePart = phone.length === 10 ? ` "${phone}"` : '';
    const entityPart = quotedName ? `"${quotedName}"` : '"primary care"';
    return `${entityPart}${phonePart}${npi} Louisville KY NPI`;
}

function verificationNextAction(status, row) {
    if (status.startsWith('Verified') && hasAddressWarning(row)) {
        return 'Identity/NPI accepted from NPPES; review address flags before import if mailing/location specificity matters.';
    }
    if (status.startsWith('Verified')) {
        return 'Identity/NPI accepted from NPPES; eligible for import candidate review.';
    }
    if (status === 'Rejected API Candidate') {
        return 'Do not use the rejected NPPES candidate; verify by official web search, phone, or a narrower source string.';
    }
    if (status === 'Needs Internet Verification') {
        return 'Use the search query to confirm official name/contact, then rerun NPPES with the verified name or NPI.';
    }
    if (status === 'Needs Human Disambiguation') {
        return 'Resolve whether the source row means an individual clinician or a facility/practice before accepting an NPI.';
    }
    return 'Search official clinic, health-system, insurer, or licensure sources; do not infer an NPI from name alone.';
}

function verifyEnrichedDirectoryRow(row) {
    const hasNpi = Boolean(row.NPI);
    const isType1 = row['NPI Type'] === 'Type 1 Individual';
    const isType2 = row['NPI Type'] === 'Type 2 Organization';
    const isHigh = row['Match Status'] === 'Matched' && row.Confidence === 'high';
    const isMedium = row['Match Status'] === 'Matched' && row.Confidence === 'medium';
    const exactName = hasBasis(row, 'exact normalized name');
    const sourceContact = hasBasis(row, 'source phone matched') || hasBasis(row, 'source fax matched');
    const weakRejected = hasReviewReason(row, 'none had name or contact evidence');
    const ambiguousName = hasReviewReason(row, 'name is not parseable');

    let status = 'Needs Internet Verification';
    const evidence = [];

    if (hasNpi && isType1 && isHigh && (exactName || sourceContact)) {
        status = 'Verified - Individual';
        evidence.push('Type 1 NPI accepted from high-confidence NPPES match');
    } else if (hasNpi && isType2 && isHigh && (exactName || sourceContact)) {
        status = 'Verified - Facility';
        evidence.push('Type 2 NPI accepted from high-confidence NPPES match');
    } else if (weakRejected) {
        status = 'Rejected API Candidate';
        evidence.push('NPPES returned candidates, but none met name/contact evidence rules');
    } else if (hasNpi && (isMedium || row.Confidence === 'low') && ambiguousName) {
        status = 'Needs Human Disambiguation';
        evidence.push('NPPES candidate exists, but the source row is ambiguous');
    } else if (hasNpi && (isMedium || row.Confidence === 'low')) {
        status = 'Needs Internet Verification';
        evidence.push('NPPES candidate exists, but confidence is not high enough for direct acceptance');
    } else if (!hasNpi && row['Provider Kind'] === 'ambiguous') {
        status = 'Needs Human Disambiguation';
        evidence.push('Source row is not enough to determine individual versus facility');
    } else if (!hasNpi) {
        evidence.push('No acceptable NPPES match found');
    }

    if (exactName) evidence.push('Exact normalized name evidence');
    if (sourceContact) evidence.push('Source phone/fax matched NPPES address');
    if (hasBasis(row, 'Kentucky location and mailing addresses')) evidence.push('Kentucky location and mailing address evidence');
    if (hasAddressWarning(row)) evidence.push('Address warning remains');

    return {
        ...row,
        'Verification Status': status,
        'Verified Entity Type': status === 'Verified - Individual' ? 'Individual clinician'
            : status === 'Verified - Facility' ? 'Facility/practice'
                : '',
        'Verification Evidence': uniqueSorted(evidence).join('; '),
        'Address Verification Needed': status.startsWith('Verified') && hasAddressWarning(row) ? 'Yes' : 'No',
        'Final Human Review Needed': status.startsWith('Verified') ? 'No' : 'Yes',
        'Internet Search Query': buildInternetSearchQuery(row),
        'Next Action': verificationNextAction(status, row)
    };
}

module.exports = {
    normalizePcpRows,
    classifyProviderCandidate,
    buildNppesQueries,
    scoreNppesMatch,
    selectBestMatch,
    formatEnrichedDirectoryRow,
    formatProviderLocationRows,
    verifyEnrichedDirectoryRow,
    normalizeDigits,
    formatPhone,
    normalizeNameForGrouping,
    addressKey
};

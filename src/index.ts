interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * estonia-business-register -- Estonia's e-Business Register, published as
 * open data by RIK (Estonian Centre of Registers and Information Systems):
 * every registered, liquidating or bankrupt entity's identity, legal form,
 * status and address, its currently reported activity areas (EMTAK/NACE),
 * and selected financial indicators and sales-by-activity breakdowns from
 * filed annual reports. Fleet #2927.
 *
 * Public surfaces (README, descriptions, `source`) name the publisher and
 * the dataset only, never the download route (CLAUDE.md step 9b,
 * fleet #2938); the route lives in scripts/estonia-business-register/.
 * RIK publishes no live per-record API and bulk files only, so
 * scripts/estonia-business-register/refresh.sh downloads the open-data
 * extracts and loads them into a D1 database the gateway hands this pack as
 * `_d1` (pack-manifest "d1Binding": "EE_BIZ_DB").
 *
 * Covers: company/entity identity, legal form, VAT number, registration
 * status and address (basic + general open-data extracts); current
 * reported EMTAK/NACE activity areas; and, from filed annual reports,
 * submission metadata plus five selected financial indicators (revenue,
 * profit/loss, total assets, equity, average FTE employee count) and sales
 * revenue broken down by activity area -- not full reports.
 *
 * Reuse terms: Creative Commons Attribution 4.0 (CC BY 4.0). Downloading
 * RIK's open data requires accepting its terms, which require attribution.
 * Every response here carries `source`, `licence` and `data_as_of`.
 */
import {
  type AnnualReportRow,
  type D1Like,
  LICENCE,
  SOURCE,
  STATUS_LABELS,
  activitiesOf,
  dataAsOf,
  findByCode,
  findByNameExact,
  normalizeName,
  reportForYear,
  reportYearsOf,
  requireDb,
  salesBreakdownOf,
  searchByNameAnyForm,
} from './store.js';
import { fetchBeneficialOwners } from './beneficial-owners.js';

const tools: McpToolExport['tools'] = [
  {
    name: 'ee_company',
    description:
      "One Estonian company or other registered entity by its registry code or exact current name, from Estonia's e-Business Register (published as open data by RIK, the Estonian Centre of Registers and Information Systems). Returns identity (name, legal form, VAT number), registration status (registered/in liquidation/bankrupt), address, and currently reported EMTAK/NACE activity areas. Use for \"what is the status of registry code 12417834\" or \"look up Bolt Technology OÜ\". A company's CURRENT registered name is matched exactly -- a FORMER name (e.g. a company later renamed) will not match by name; look it up by registry code instead if known. For partial name matches use ee_company_search first.",
    summary: "One Estonian entity (RIK's e-Business Register) by registry code or exact current name: identity, status, address, activity.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        registry_code: { type: 'string', description: 'Estonian registry code (ariregistri kood), e.g. "12417834".' },
        name: { type: 'string', description: 'Exact current registered name, e.g. "Bolt Technology OÜ". Case/diacritic-insensitive (works with or without õ/ä/ö/ü). Use ee_company_search for partial names.' },
      },
    },
  },
  {
    name: 'ee_company_search',
    description:
      "Search Estonia's e-Business Register (RIK open data) by the start of a company's current name, optionally filtered by registration status (registered, liquidation or bankrupt; any other value is refused, not ignored). Prefix match first (\"Bolt\" finds \"Bolt Technology OÜ\" but not \"EuroBolt OÜ\"); only when nothing starts with the text does it fall back to a weaker contains-the-text pass and report match_mode:'substring'; diacritic-insensitive, so plain-ASCII and Estonian spellings both work; the legal form is optional and can sit either side (\"Tallinna Sadam\", \"Tallinna Sadam AS\" and \"AS Tallinna Sadam\" all find \"aktsiaselts TALLINNA SADAM\"), and the company whose name matches exactly apart from its legal form is listed first. Use for \"find Estonian companies named Bolt...\" or to get a registry code to pass to ee_company.",
    summary: "Search Estonia's e-Business Register by name prefix, optionally filtered by status.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Start of the company\'s current registered name, e.g. "Bolt".' },
        status: { type: 'string', enum: ['registered', 'liquidation', 'bankrupt', 'active'], description: 'Filter by registration status. "active" is a synonym for "registered". Case-insensitive; any other value is refused with the valid list.' },
        limit: { type: 'number', description: 'Maximum results (1-100, default 20).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'ee_annual_report_stats',
    description:
      "Selected financial indicators and sales-by-activity breakdowns from an Estonian entity's filed annual reports (RIK's monthly open-data extracts of e-Business Register annual reports) -- NOT full reports. Pass registry_code alone to list every year with a filed report (submission date, audited flag, filer-size category); add year for that year's figures: revenue, profit/loss, total assets, equity, average full-time-equivalent employee count, and sales revenue broken down by EMTAK activity area. Some filed reports carry metadata but no matching figures in RIK's extract (seen for some large/group filers) -- the report row still answers, with null figures.",
    summary: 'Selected financial indicators + sales breakdown from an Estonian entity\'s filed annual reports, by registry code and optional year.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        registry_code: { type: 'string', description: 'Estonian registry code (ariregistri kood), e.g. "11056239".' },
        year: { type: 'string', description: 'Report year, e.g. "2024". Omit to list every year with a filed report.' },
      },
      required: ['registry_code'],
    },
  },
  {
    name: 'ee_beneficial_owners',
    description:
      "An Estonian entity's beneficial owners (Estonia's e-Business Register, published by RIK, the Estonian Centre of Registers and Information Systems) by registry code or exact current name: each owner's name, date of birth and nationality EXACTLY as the register itself shows them, the manner in which control is exercised (direct/indirect ownership etc.), and the start date of that holding. RIK marks this data as informative rather than authoritative, and the register carries no live per-record API for it -- this tool reads the register's own public company page, live, per request, so data_as_of reflects RIK's own last-updated date for the beneficial-owners section specifically. Anyone named here can request removal at support@pipeworx.io; a removal already on file is silently withheld and counted in withheld_by_removal_request.",
    summary: "An Estonian entity's beneficial owners (name, DOB, nationality, manner of control) from RIK's own public page, live per request.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        registry_code: { type: 'string', description: 'Estonian registry code (ariregistri kood), e.g. "11056239".' },
        name: { type: 'string', description: 'Exact current registered name. Use ee_company_search first for a partial match, or pass registry_code directly if known.' },
      },
    },
  },
];

function clamp(v: unknown, lo: number, hi: number, d: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : d;
}

const STATUS_CODE_OF: Record<string, string> = { registered: 'R', liquidation: 'L', bankrupt: 'N' };
/** 'active' is the word the status label itself uses ("Registered (active)"). */
const STATUS_ALIASES: Record<string, string> = { active: 'registered' };
const LEGAL_STATUS_VALUES = Object.keys(STATUS_CODE_OF);

async function companyPayload(db: D1Like, row: Awaited<ReturnType<typeof findByCode>>) {
  if (!row) throw new Error('companyPayload called with no row');
  const [activities, asOf] = await Promise.all([activitiesOf(db, row.registry_code), dataAsOf(db)]);
  return {
    found: true,
    company: {
      registry_code: row.registry_code,
      name: row.name,
      legal_form: row.legal_form,
      legal_form_subtype: row.legal_form_subtype,
      vat_number: row.vat_number,
    },
    status: {
      code: row.status_code,
      label: row.status_code ? STATUS_LABELS[row.status_code] ?? row.status_code : null,
      text_et: row.status_text,
      first_entry_date: row.first_entry_date,
    },
    address: {
      full: row.address,
      district_city_county: row.ehak_text,
      postal_index: row.postal_index,
    },
    activities: activities.map((a) => ({
      emtak_code: a.emtak_code,
      emtak_text_et: a.emtak_text,
      nace_code: a.nace_code,
      is_primary: !!a.is_primary,
    })),
    register_url: row.register_url,
    data_as_of: asOf,
    source: SOURCE,
    licence: LICENCE,
  };
}

async function companyTool(db: D1Like, args: Record<string, unknown>) {
  const code = args.registry_code != null && args.registry_code !== '' ? String(args.registry_code).trim() : null;
  const name = args.name != null && args.name !== '' ? String(args.name).trim() : null;
  if (!code && !name) {
    return {
      found: false,
      reason: 'missing_argument',
      message: 'Pass registry_code or name.',
      data_as_of: null,
      source: SOURCE,
    };
  }
  const asOf = await dataAsOf(db);
  if (code) {
    const row = await findByCode(db, code);
    if (!row) {
      return {
        found: false,
        reason: 'not_held',
        registry_code: code,
        message: `No entity with registry code ${code} is in the e-Business Register data as of ${asOf ?? 'the last refresh'}.`,
        hint: 'Check the registry code, or use ee_company_search by name.',
        data_as_of: asOf,
        source: SOURCE,
      };
    }
    return companyPayload(db, row);
  }
  const nameNorm = normalizeName(name);
  const rows = await findByNameExact(db, nameNorm);
  if (!rows.length) {
    return {
      found: false,
      reason: 'not_found',
      name,
      message: `No entity in the e-Business Register currently has the exact registered name ${JSON.stringify(name)}.`,
      hint: 'A company that was later RENAMED will not match its former name here -- try the registry code if known, or use ee_company_search for a partial match.',
      data_as_of: asOf,
      source: SOURCE,
    };
  }
  if (rows.length > 1) {
    return {
      found: false,
      reason: 'ambiguous',
      name,
      message: `${rows.length} entities share the exact registered name ${JSON.stringify(name)}.`,
      candidates: rows.map((r) => ({ registry_code: r.registry_code, name: r.name, status_code: r.status_code })),
      data_as_of: asOf,
      source: SOURCE,
    };
  }
  return companyPayload(db, rows[0]);
}

async function searchTool(db: D1Like, args: Record<string, unknown>) {
  const name = String(args.name ?? '').trim();
  if (!name) throw new Error('name is required');
  const statusArg = args.status != null && args.status !== '' ? String(args.status) : null;
  let statusCode: string | null = null;
  if (statusArg) {
    const key = statusArg.trim().toLowerCase();
    statusCode = STATUS_CODE_OF[STATUS_ALIASES[key] ?? key] ?? null;
    if (!statusCode) {
      throw new Error(
        `Unknown status ${JSON.stringify(statusArg)}. Valid values: ${LEGAL_STATUS_VALUES.join(', ')} (case-insensitive; 'active' is accepted for registered). Omit status to search all.`,
      );
    }
  }
  const limit = clamp(args.limit, 1, 100, 20);
  const asOf = await dataAsOf(db);
  const { rows, matchMode } = await searchByNameAnyForm(db, normalizeName(name), statusCode, limit);
  return {
    name,
    status: statusArg ? statusArg.trim().toLowerCase() : null,
    match_mode: matchMode,
    returned: rows.length,
    results: rows.map((r) => ({
      registry_code: r.registry_code,
      name: r.name,
      legal_form: r.legal_form,
      status_code: r.status_code,
      status_label: r.status_code ? STATUS_LABELS[r.status_code] ?? r.status_code : null,
    })),
    ...(rows.length === 0
      ? {
          found: false,
          reason: 'no_match',
          hint: 'No name starts with, or contains, that text -- check spelling/diacritics or try a shorter fragment.',
        }
      : {}),
    data_as_of: asOf,
    source: SOURCE,
  };
}

function shapeReportYear(r: AnnualReportRow) {
  return {
    report_year: r.report_year,
    period_start: r.period_start,
    period_end: r.period_end,
    submitted_date: r.submitted_date,
    audited: r.audited,
    category_et: r.category,
    has_figures: r.revenue != null || r.profit_loss != null || r.assets != null || r.equity != null || r.employees_fte != null,
  };
}

async function annualReportTool(db: D1Like, args: Record<string, unknown>) {
  const code = String(args.registry_code ?? '').trim();
  if (!code) throw new Error('registry_code is required');
  const year = args.year != null && args.year !== '' ? String(args.year).trim() : null;
  const asOf = await dataAsOf(db);
  const company = await findByCode(db, code);
  if (!company) {
    return {
      found: false,
      reason: 'not_held',
      registry_code: code,
      message: `No entity with registry code ${code} is in the e-Business Register data as of ${asOf ?? 'the last refresh'}.`,
      data_as_of: asOf,
      source: SOURCE,
    };
  }

  if (!year) {
    const years = await reportYearsOf(db, code);
    if (!years.length) {
      return {
        found: false,
        reason: 'no_reports',
        registry_code: code,
        name: company.name,
        message: `No filed annual report is held for ${company.name} (registry code ${code}).`,
        data_as_of: asOf,
        source: SOURCE,
      };
    }
    return {
      found: true,
      registry_code: code,
      name: company.name,
      years: years.map(shapeReportYear),
      data_as_of: asOf,
      source: SOURCE,
      licence: LICENCE,
    };
  }

  const report = await reportForYear(db, code, year);
  if (!report) {
    return {
      found: false,
      reason: 'not_held',
      registry_code: code,
      name: company.name,
      year,
      message: `No filed annual report for ${year} is held for ${company.name} (registry code ${code}).`,
      hint: 'Omit year to list every year with a filed report.',
      data_as_of: asOf,
      source: SOURCE,
    };
  }
  const sales = await salesBreakdownOf(db, report.report_id);
  return {
    found: true,
    registry_code: code,
    name: company.name,
    report: {
      report_year: report.report_year,
      period_start: report.period_start,
      period_end: report.period_end,
      submitted_date: report.submitted_date,
      audited: report.audited,
      category_et: report.category,
    },
    figures: {
      revenue: report.revenue,
      profit_loss: report.profit_loss,
      assets: report.assets,
      equity: report.equity,
      employees_fte: report.employees_fte,
      currency: report.revenue != null || report.assets != null ? 'EUR' : null,
    },
    sales_by_activity: sales.map((s) => ({
      emtak_code: s.emtak,
      sales_amount: s.sales_amount,
      is_primary_activity: !!s.is_primary_activity,
      emtak_version: s.emtak_version,
    })),
    data_as_of: asOf,
    source: SOURCE,
    licence: LICENCE,
  };
}

/** Resolve registry_code/name to a registry code + (when known) the
 *  company's current name, reusing the same D1 lookup the other tools use --
 *  so "name" behaves identically everywhere in this pack. A name that does
 *  not resolve still falls through to a direct registry_code lookup when one
 *  was ALSO given; it only fails when neither resolves. */
async function resolveBeneficialOwnersTarget(
  db: D1Like,
  args: Record<string, unknown>,
): Promise<{ registryCode: string; companyName: string | null } | { error: Record<string, unknown> }> {
  const code = args.registry_code != null && args.registry_code !== '' ? String(args.registry_code).trim() : null;
  const name = args.name != null && args.name !== '' ? String(args.name).trim() : null;
  if (!code && !name) {
    return { error: { found: false, reason: 'missing_argument', message: 'Pass registry_code or name.', data_as_of: null, source: SOURCE } };
  }
  if (code) return { registryCode: code, companyName: null };

  const nameNorm = normalizeName(name);
  const rows = await findByNameExact(db, nameNorm);
  if (!rows.length) {
    return {
      error: {
        found: false,
        reason: 'not_found',
        name,
        message: `No entity in the e-Business Register currently has the exact registered name ${JSON.stringify(name)}.`,
        hint: 'A company that was later RENAMED will not match its former name here -- try the registry code if known, or use ee_company_search for a partial match.',
        data_as_of: await dataAsOf(db),
        source: SOURCE,
      },
    };
  }
  if (rows.length > 1) {
    return {
      error: {
        found: false,
        reason: 'ambiguous',
        name,
        message: `${rows.length} entities share the exact registered name ${JSON.stringify(name)}.`,
        candidates: rows.map((r) => ({ registry_code: r.registry_code, name: r.name, status_code: r.status_code })),
        data_as_of: await dataAsOf(db),
        source: SOURCE,
      },
    };
  }
  return { registryCode: rows[0]!.registry_code, companyName: rows[0]!.name };
}

async function beneficialOwnersTool(db: D1Like, args: Record<string, unknown>) {
  const resolved = await resolveBeneficialOwnersTarget(db, args);
  if ('error' in resolved) return resolved.error;
  return fetchBeneficialOwners(resolved.registryCode, resolved.companyName);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const db = requireDb(args._d1);
  switch (name) {
    case 'ee_company':
      return companyTool(db, args);
    case 'ee_company_search':
      return searchTool(db, args);
    case 'ee_annual_report_stats':
      return annualReportTool(db, args);
    case 'ee_beneficial_owners':
      return beneficialOwnersTool(db, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;

/**
 * Reads for estonia-business-register (fleet #2927).
 *
 * Data comes from RIK (Estonian Centre of Registers and Information
 * Systems), publisher of the e-Business Register. RIK publishes no live
 * per-record API -- only bulk open-data files -- so a build script (route
 * kept out of every public surface, CLAUDE.md step 9b, a4c024647) downloads
 * them and loads them into a D1 database the gateway hands this pack as
 * `_d1` (pack-manifest "d1Binding": "EE_BIZ_DB"). Table/column names here
 * must match scripts/estonia-business-register/schema.sql.
 *
 * Reuse terms: Creative Commons Attribution 4.0 (CC BY 4.0). Downloading the
 * open data requires accepting RIK's terms, which require attribution; every
 * response here carries `source`, `licence` and `data_as_of` to satisfy
 * that. If the open data contains personal data, GDPR governs its further
 * processing -- RIK itself has stopped publishing personal identification
 * numbers in these files since 2024-11-01.
 */

/** The slice of Cloudflare's D1Database this pack uses, declared here so the
 *  pack needs no workers-types and a test can pass a node:sqlite stub. */
export interface D1Like {
  prepare(sql: string): D1StmtLike;
}
export interface D1StmtLike {
  bind(...values: unknown[]): D1StmtLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export const SOURCE = 'RIK (Estonian Centre of Registers and Information Systems), e-Business Register open data';
export const LICENCE =
  "Creative Commons Attribution 4.0 (CC BY 4.0) -- downloading RIK's open data requires accepting its terms, " +
  'which require attribution to the source. If the data contains personal data, further processing is subject ' +
  'to GDPR; RIK itself stopped publishing personal identification numbers in these files from 2024-11-01.';

export class StoreUnavailableError extends Error {
  constructor() {
    super(
      'estonia-business-register: the register is not bound in this runtime (no _d1). These tools only answer through the Pipeworx gateway; a standalone install has no data to read.',
    );
    this.name = 'StoreUnavailableError';
  }
}
export function requireDb(d1: unknown): D1Like {
  if (!d1 || typeof (d1 as D1Like).prepare !== 'function') throw new StoreUnavailableError();
  return d1 as D1Like;
}

export async function dataAsOf(db: D1Like): Promise<string | null> {
  const r = await db.prepare(`SELECT value FROM ee_meta WHERE key = 'data_as_of'`).first<{ value: string }>();
  return r?.value ?? null;
}

/** Fold diacritics, uppercase, collapse punctuation/whitespace to single
 *  spaces. MUST match normalize_name() in
 *  scripts/estonia-business-register/build-sqlite.py. Lets an English-typed
 *  or diacritic-free query ("Bolt Technology OU") find the same row as the
 *  Estonian-registered form ("Bolt Technology OÜ"). */
export function normalizeName(s: unknown): string {
  if (s == null) return '';
  return String(s)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

export const STATUS_LABELS: Record<string, string> = {
  R: 'Registered (active)',
  L: 'In liquidation',
  N: 'Bankrupt',
};

export interface CompanyRow {
  registry_code: string;
  name: string;
  name_norm: string;
  legal_form: string | null;
  legal_form_subtype: string | null;
  vat_number: string | null;
  status_code: string | null;
  status_text: string | null;
  first_entry_date: string | null;
  address: string | null;
  ehak_text: string | null;
  postal_index: string | null;
  register_url: string | null;
}
const COMPANY_COLS = `registry_code, name, name_norm, legal_form, legal_form_subtype, vat_number, status_code,
  status_text, first_entry_date, address, ehak_text, postal_index, register_url`;

export async function findByCode(db: D1Like, code: string): Promise<CompanyRow | null> {
  return db
    .prepare(`SELECT ${COMPANY_COLS} FROM ee_companies WHERE registry_code = ?`)
    .bind(code)
    .first<CompanyRow>();
}

export async function findByNameExact(db: D1Like, nameNorm: string): Promise<CompanyRow[]> {
  const r = await db
    .prepare(`SELECT ${COMPANY_COLS} FROM ee_companies WHERE name_norm = ? ORDER BY registry_code`)
    .bind(nameNorm)
    .all<CompanyRow>();
  return r.results;
}

/** Prefix range scan on the indexed name_norm column -- same shape as
 *  france-bdpm-medicines searchByName. Deliberately not FTS5: a plain
 *  B-tree range query needs no post-import rebuild step at all, sidestepping
 *  the chunked-export FTS5 trap entirely (reference_d1_fts5_import_trap.md). */
export async function searchByName(
  db: D1Like,
  prefixNorm: string,
  statusCode: string | null,
  limit: number,
): Promise<CompanyRow[]> {
  const params: unknown[] = [prefixNorm, `${prefixNorm}￿`];
  let sql = `SELECT ${COMPANY_COLS} FROM ee_companies WHERE name_norm >= ? AND name_norm < ?`;
  if (statusCode) {
    sql += ` AND status_code = ?`;
    params.push(statusCode);
  }
  sql += ` ORDER BY name_norm LIMIT ?`;
  params.push(limit);
  const r = await db.prepare(sql).bind(...params).all<CompanyRow>();
  return r.results;
}

export interface ActivityRow {
  emtak_code: string | null;
  emtak_text: string | null;
  nace_code: string | null;
  is_primary: number;
}
export async function activitiesOf(db: D1Like, code: string): Promise<ActivityRow[]> {
  const r = await db
    .prepare(
      `SELECT emtak_code, emtak_text, nace_code, is_primary FROM ee_activities WHERE registry_code = ? ORDER BY is_primary DESC, emtak_code`,
    )
    .bind(code)
    .all<ActivityRow>();
  return r.results;
}

export interface AnnualReportRow {
  report_id: string;
  registry_code: string;
  report_year: string | null;
  period_start: string | null;
  period_end: string | null;
  submitted_date: string | null;
  audited: string | null;
  category: string | null;
  revenue: number | null;
  profit_loss: number | null;
  assets: number | null;
  equity: number | null;
  employees_fte: number | null;
}
const REPORT_COLS = `report_id, registry_code, report_year, period_start, period_end, submitted_date, audited,
  category, revenue, profit_loss, assets, equity, employees_fte`;

export async function reportYearsOf(db: D1Like, code: string): Promise<AnnualReportRow[]> {
  const r = await db
    .prepare(`SELECT ${REPORT_COLS} FROM ee_annual_reports WHERE registry_code = ? ORDER BY report_year DESC`)
    .bind(code)
    .all<AnnualReportRow>();
  return r.results;
}

export async function reportForYear(db: D1Like, code: string, year: string): Promise<AnnualReportRow | null> {
  return db
    .prepare(`SELECT ${REPORT_COLS} FROM ee_annual_reports WHERE registry_code = ? AND report_year = ?`)
    .bind(code, year)
    .first<AnnualReportRow>();
}

export interface SalesRow {
  emtak: string | null;
  sales_amount: number | null;
  is_primary_activity: number;
  emtak_version: string | null;
}
export async function salesBreakdownOf(db: D1Like, reportId: string): Promise<SalesRow[]> {
  const r = await db
    .prepare(
      `SELECT emtak, sales_amount, is_primary_activity, emtak_version FROM ee_annual_report_sales
       WHERE report_id = ? ORDER BY is_primary_activity DESC, sales_amount DESC`,
    )
    .bind(reportId)
    .all<SalesRow>();
  return r.results;
}

# @pipeworx/estonia-business-register

Estonia's e-Business Register, published as open data by RIK (the Estonian
Centre of Registers and Information Systems): every registered, liquidating
or bankrupt entity's identity, legal form, status and address, its currently
reported activity areas (EMTAK/NACE), and selected financial indicators and
sales-by-activity breakdowns from filed annual reports. Fleet #2927.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1773+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

RIK publishes no live per-record API — only bulk open-data files — so
Pipeworx keeps a daily-refreshed copy of the register.

## Tools

- `ee_company(registry_code?, name?)` — one entity by its registry code or
  its exact current registered name: identity (name, legal form, VAT
  number), registration status, address and currently reported EMTAK/NACE
  activity areas. A company's **former** name (before a rename) will not
  match by name — look it up by registry code instead. For partial names,
  use `ee_company_search` first.
- `ee_company_search(name, status?, limit?)` — search by the start of a
  company's current name (prefix match only — "Bolt" finds "Bolt Technology
  OÜ" but not "EuroBolt OÜ"), diacritic-insensitive, optionally filtered by
  registration status.
- `ee_annual_report_stats(registry_code, year?)` — from filed annual
  reports: pass `registry_code` alone to list every year with a filed
  report (submission date, audited flag, filer-size category); add `year`
  for that year's selected financial indicators (revenue, profit/loss,
  total assets, equity, average FTE employee count) and sales revenue
  broken down by EMTAK activity area. **Not full reports** — only the
  indicators RIK's own extract tags with a standardized element name. Some
  filed reports (seen for some large/group filers) carry metadata but no
  matching figures in RIK's extract; the report row still answers, with
  null figures, rather than a silent empty result.

Every response carries `data_as_of` (the day the mirror was last
refreshed), `source` and (where licence terms apply) `licence`.

### Matching a renamed entity

RIK's basic/general extracts carry only each entity's **current** name —
the register data carries no former-name index. A well-known example: the
company now named "Microsoft Development Center Estonia OÜ" (registry code
`11056239`) traded as "Skype Technologies OÜ" from 2004 until a 2021
rename. `ee_company(name: "Skype Technologies")` correctly returns
`not_found` with a hint to try the registry code; `ee_company(registry_code:
"11056239")` resolves it.

### Status codes

`status_code` is one of `R` (registered/active), `L` (in liquidation) or
`N` (bankrupt) — the three statuses RIK's basic open-data extract carries.
A `status_label` field spells these out in English; `status.text_et` keeps
RIK's own Estonian wording alongside it.

### Activity areas

`ee_company`'s `activities` list and `ee_annual_report_stats`' sales
breakdown use Estonia's EMTAK classification (with the corresponding EU
NACE code alongside), reported as of the mirror's `data_as_of` date —
historical/ended activity-area entries are not carried.

## Auth

Keyless. The tools answer only through the Pipeworx gateway, which holds
the copy of the register; a standalone `npm install` has no data to read,
and every tool throws a clear "not bound in this runtime" error there
instead of returning an empty list.

## Data sources

- RIK (Estonian Centre of Registers and Information Systems), e-Business
  Register open data — basic and general entity extracts (identity, legal
  form, VAT number, status, address, currently reported activity areas),
  refreshed daily; and the monthly annual-report extracts (submission
  metadata, selected financial-statement indicators and sales-by-activity
  breakdowns), covering reports filed 2019–2025.

**Licence: Creative Commons Attribution 4.0 (CC BY 4.0).** Downloading
RIK's open data requires accepting its terms, which require attributing
the source — exactly the `source` + `data_as_of` every response here
carries. If the open data contains personal data, further processing is
subject to GDPR; RIK itself stopped publishing personal identification
numbers in these files from 2024-11-01.

### Why no full-text name search

Name search here is a prefix range-scan on a normalized, indexed column
(diacritics folded, uppercased) rather than an FTS5 index. For this
dataset's size and the prefix-match use case, that is simpler and avoids a
known trap with D1's chunked import: an FTS5 virtual table's postings do
not travel through the generic chunked export/import path and would need a
separate, batched server-side rebuild after every load. A plain indexed
range query needs none of that.

### Why some annual reports have no figures

The five financial indicators (`revenue`, `profit_loss`, `assets`,
`equity`, `employees_fte`) come from RIK's monthly "report elements"
extract, matched by a small set of standardized element names (e.g.
`Revenue`, `TotalProfitLoss`, `Assets`, `Equity`,
`AverageNumberOfEmployeesInFullTimeEquivalentUnits`, preferring the
non-consolidated form when both exist). Some filers' reports — observed for
some large/holding-company filers — have no row at all in that extract for
a given year, even though the report itself was filed and its metadata
(dates, audited flag, category) is held. `ee_annual_report_stats` answers
with real metadata and `null` figures in that case, never a silent empty
result.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "estonia-business-register": {
      "url": "https://gateway.pipeworx.io/estonia-business-register/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/estonia-business-register/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1773+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ee_company \
  -H 'Content-Type: application/json' \
  -d '{"registry_code":"12417834"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ee_company`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "estonia-business-register": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-estonia-business-register"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-estonia-business-register
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Estonia Business Register data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

// regen-universe.js
// -----------------------------------------------------------------------------
// DEV-ONLY UTILITY — NOT USED IN PRODUCTION / AT RUNTIME.
//
// Regenerates lib/data/universe.json from the human-editable source of truth,
// the Tradeable Universe tab of signa_tracker.xlsx. The bot reads ONLY the JSON
// at runtime (see lib/universe-loader.js); the xlsx is never deployed.
//
// This script reads the xlsx from OUTSIDE the bot repo — it points at the
// user's local paper-trading workbook, which lives as a sibling of the repo and
// is intentionally NOT committed. It therefore only runs on a machine where
// that workbook exists (the maintainer's Mac), not on Railway.
//
// Workflow when the universe changes:
//   1. Edit signa_tracker.xlsx → Tradeable Universe tab.
//   2. Run:  node scripts/regen-universe.js
//   3. Commit the regenerated lib/data/universe.json.
//
// Eligibility cells in the xlsx are formulas resolving to yes/no; this script
// bakes them down to literal booleans in the JSON.
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import xlsx from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Source of truth — sibling paper-trading workbook, outside the repo.
const WORKBOOK_PATH = path.resolve(
  __dirname,
  '../../paper-trading/signa_tracker.xlsx'
);
const SHEET_NAME = 'Tradeable Universe';

// Output — committed JSON the bot reads at runtime.
const OUTPUT_PATH = path.resolve(__dirname, '../lib/data/universe.json');

// yes/no/TRUE/1 → boolean.
function toBool(v) {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'y' || s === '1';
}

function main() {
  const wb = xlsx.readFile(WORKBOOK_PATH);
  const ws = wb.Sheets[SHEET_NAME];
  if (!ws) {
    throw new Error(
      `regen-universe: sheet "${SHEET_NAME}" not found in ${WORKBOOK_PATH}. ` +
        `Available: ${wb.SheetNames.join(', ')}`
    );
  }

  const rows = xlsx.utils.sheet_to_json(ws, { defval: null });

  // Keep real ticker rows only: skip the header (handled by sheet_to_json),
  // blank spacer rows, and the legend footer (which has a ticker-ish string but
  // no asset_class).
  const tickers = rows
    .filter(
      (r) =>
        r.ticker != null &&
        String(r.ticker).trim() !== '' &&
        r.asset_class != null &&
        String(r.asset_class).trim() !== ''
    )
    .map((r) => ({
      ticker: String(r.ticker).trim().toUpperCase(),
      asset_class: String(r.asset_class).trim(),
      exchanges: r.exchanges != null ? String(r.exchanges).trim() : null,
      signals_eligible: toBool(r.signals_eligible),
      micro_eligible: toBool(r.micro_eligible),
      macro_eligible: toBool(r.macro_eligible),
    }));

  const out = {
    generated_at: new Date().toISOString(),
    source: 'signa_tracker.xlsx Tradeable Universe tab',
    tickers,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2) + '\n');

  console.log(
    `✅ Wrote ${tickers.length} tickers to ${path.relative(
      path.resolve(__dirname, '..'),
      OUTPUT_PATH
    )}`
  );
}

main();

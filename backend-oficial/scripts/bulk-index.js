import 'dotenv/config';
import { bulkIndexPartners } from '../services/rag.service.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { onlyMissing: true, limit: 1000 };
  for (const a of args) {
    if (a === '--all' || a === '--force') out.onlyMissing = false;
    const mLimit = a.match(/^--limit=(\d+)$/);
    if (mLimit) out.limit = Math.max(1, Math.min(parseInt(mLimit[1], 10), 5000));
  }
  return out;
}

(async () => {
  try {
    const opts = parseArgs();
    console.log('[bulk-index] options:', opts);
    const res = await bulkIndexPartners(opts);
    console.log('[bulk-index] resultado:', JSON.stringify(res, null, 2));
  } catch (e) {
    console.error('[bulk-index] erro:', e?.message || e);
    process.exit(1);
  }
})();

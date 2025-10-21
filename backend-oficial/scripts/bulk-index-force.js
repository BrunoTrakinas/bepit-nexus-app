import 'dotenv/config';
import { bulkIndexPartners } from '../services/rag.service.js';

(async () => {
  try {
    const res = await bulkIndexPartners({ onlyMissing: false, limit: 1000 });
    console.log('[bulk-index:force] resultado:', JSON.stringify(res, null, 2));
  } catch (e) {
    console.error('[bulk-index:force] erro:', e?.message || e);
    process.exit(1);
  }
})();
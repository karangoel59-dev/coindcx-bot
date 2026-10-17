/** Run with the service stopped. Defaults to inspection; --confirm clears only a proved closed entry. */
import { Broker } from '../broker.js';
import { buildClient } from '../client.js';
import { loadConfig } from '../config.js';
import { acquireLock, releaseLock } from '../lock.js';
import { PriceFeed } from '../marks.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const index = args.indexOf('--client-order-id');
  const clientOrderId = index < 0 ? undefined : args[index + 1];
  if (!clientOrderId || !/^b[0-9a-f]{32}$/.test(clientOrderId) ||
      args.filter(arg => arg === '--client-order-id').length !== 1 ||
      args.filter(arg => arg === '--confirm').length > 1 || args.some((arg, i) =>
    arg !== '--confirm' && arg !== '--client-order-id' && i !== index + 1)) {
    throw new Error('Usage: MODE=live npm run recover-entry -- --client-order-id b<32 hex digits> [--confirm]');
  }
  const cfg = loadConfig();
  if (cfg.mode !== 'live') throw new Error('Recovery requires MODE=live');
  acquireLock();
  try {
    const client = buildClient(cfg);
    try {
      const broker = new Broker(client, cfg, new PriceFeed(client, cfg));
      const proof = await broker.recoverCompletedEntry(clientOrderId, args.includes('--confirm'));
      console.log(JSON.stringify(proof, null, 2));
    } finally { client.disconnect(); }
  } finally { releaseLock(); }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

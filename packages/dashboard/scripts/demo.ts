/**
 * Serves the dashboard over an in memory fake ledger with a couple of weeks of
 * plausible events, so the page can be viewed without a real Reins store.
 *
 *   node scripts/demo.ts            (Node 22.6 or later strips the types)
 *   pnpm demo                       (tsx)
 *   PORT=5000 node scripts/demo.ts
 */
import { startDashboard } from '../src/index.ts';
import { fakeCore, makeFakeReins, seedDemoLedger } from '../test/fake-reins.ts';

const port = Number(process.env.PORT ?? 4242);
const reins = makeFakeReins();
seedDemoLedger(reins, { days: 14, seed: 11 });

const running = await startDashboard({ port, reins, core: fakeCore });
console.log('Reins dashboard demo on ' + running.url);
console.log(reins.ledger.events.length + ' events in the fake ledger for ' + reins.config.agentId + ' and ops-bot. Ctrl C to stop.');

const stop = () => { running.close().then(() => process.exit(0), () => process.exit(1)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// Runs the test suite against Postgres (PGlite = real Postgres compiled to WebAssembly), no Docker needed.
// Usage: npm run test:pg
import { spawn } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = 54329;
const pglite = await PGlite.create();
const server = new PGLiteSocketServer({ db: pglite, port, host: '127.0.0.1' });
await server.start();

const child = spawn(process.execPath, ['--test', '--test-concurrency=1', 'test/study.test.js', 'test/api.test.js', 'test/postgres.test.js'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    TEST_DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    // PGlite is a single Postgres session, so the pool must not open parallel connections.
    PG_POOL_MAX: '1',
  },
});
child.on('exit', async (code) => {
  await server.stop();
  await pglite.close();
  process.exit(code ?? 1);
});

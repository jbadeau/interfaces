/**
 * Renders a Restish JSON response with the shared design atoms.
 * Usage: restish todos <command> ... -o json | node cli/render.ts <command>
 */
import { operations } from '@demo/contract';
import { layoutFor, successSchema } from '@demo/design';
import { render } from '@demo/design/terminal';
import { isDone, isOperation, pollOperation } from '@demo/contract/async';

import { spawn } from 'node:child_process';

/** GET through Restish itself, so polling uses the same profile and credentials. */
const restishGet = (href: string) => new Promise<any>((resolve, reject) => {
  // stdin closed: Restish would otherwise wait for a request body.
  const p = spawn('restish', ['get', `todos${href}`, '-o', 'json', '--rsh-ignore-status-code'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.on('error', reject);
  p.on('close', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
});

const command = process.argv[2] ?? '';
const operationId = command.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const found = [...operations()].find((o) => o.op.operationId === operationId);

let input = '';
for await (const chunk of process.stdin) input += chunk;

let body: unknown;
try {
  body = input.trim() ? JSON.parse(input) : undefined;
} catch {
  process.stdout.write(input); // not JSON (e.g. a Restish message) -> pass through
  process.exit(0);
}
const schema = found && successSchema(found.op);

// Long-running operation (202 + Operation): poll it, redrawing one progress line.
if (isOperation(body) && !isDone(body)) {
  const tty = process.stdout.isTTY || !!process.env.FORCE_COLOR;
  body = await pollOperation(body, restishGet, {
    onUpdate: (op) => {
      if (isDone(op)) return;
      const line = render(layoutFor(schema, op)); // the 202 schema is the Operation schema
      if (tty) process.stdout.write(`\r\x1b[2K${line}`);
      else console.log(line);
    },
  }).catch((problem) => problem); // e.g. 401/429 while polling: render it like any problem
  if (tty) process.stdout.write('\r\x1b[2K');
}

console.log(render(layoutFor(schema, body, found?.op.summary ? `${found.op.summary}: done.` : 'Done.')));
if (isOperation(body) && (body as any).status === 'failed') process.exitCode = 1;

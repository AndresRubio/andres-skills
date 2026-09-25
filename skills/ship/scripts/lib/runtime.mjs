import net from 'node:net';
import { git } from './git.mjs';

function tryListen(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => resolve({ ok: false, err }));
    server.once('listening', () => server.close(() => resolve({ ok: true })));
    if (host === undefined) server.listen(port);
    else server.listen(port, host);
  });
}

// A port only counts as free if nothing is bound to it on the wildcard address,
// on 127.0.0.1, or on ::1. A bare wildcard-only check can miss a dev server (e.g.
// Vite) that binds only to 127.0.0.1: on macOS a wildcard bind can still succeed
// even while such a loopback-only listener holds the port.
export async function isPortFree(port) {
  const wildcard = await tryListen(port);
  if (!wildcard.ok) return false;
  const v4 = await tryListen(port, '127.0.0.1');
  if (!v4.ok) return false;
  const v6 = await tryListen(port, '::1');
  if (!v6.ok) {
    const code = v6.err?.code;
    if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') return true; // no IPv6 here: not a blocker
    return false;
  }
  return true;
}

export async function findFreePort(start = 5173, attempts = 100) {
  for (let port = start; port < start + attempts; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`no free port in ${start}-${start + attempts - 1}`);
}

export function parseNumstat(text) {
  let files = 0;
  let lines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [added, removed] = line.split('\t');
    files += 1;
    if (added !== '-') lines += Number(added) + Number(removed);
  }
  return { files, lines };
}

export function diffSize(cwd, base) {
  return parseNumstat(git(cwd, ['diff', '--numstat', `${base}...HEAD`]));
}

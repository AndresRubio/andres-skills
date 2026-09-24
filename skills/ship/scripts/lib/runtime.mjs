import net from 'node:net';
import { git } from './git.mjs';

export function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port);
  });
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

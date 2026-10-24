import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Environment settings take precedence. Self-hosted defaults are generated
// once in private state, so website and stdio sessions survive restarts.
export function loadRuntimeSecrets(directory = fileURLToPath(new URL('../data/', import.meta.url)), env = process.env) {
  const keys = ['JWT_SECRET', 'ADMIN_KEY'];
  if (keys.every(k => env[k])) return Object.fromEntries(keys.map(k => [k, env[k]]));
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, 'runtime-secrets.json');
  let stored;
  try { stored = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const generated = Object.fromEntries(keys.map(k => [k, crypto.randomBytes(32).toString('hex')]));
    try { fs.writeFileSync(filename, JSON.stringify(generated) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; }
    stored = JSON.parse(fs.readFileSync(filename, 'utf8'));
  }
  fs.chmodSync(filename, 0o600);
  if (keys.some(k => typeof stored[k] !== 'string' || stored[k].length < 32)) throw new Error('Invalid runtime secrets file');
  return Object.fromEntries(keys.map(k => [k, env[k] || stored[k]]));
}

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';

export function readEnv(file = resolve('.env')) {
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
}

export function saveEnv(values, file = resolve('.env')) {
  const content = Object.entries(values).filter(([key, value]) =>
    /^[A-Z][A-Z0-9_]*$/.test(key) && value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join('\n') + '\n';
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, file);
}

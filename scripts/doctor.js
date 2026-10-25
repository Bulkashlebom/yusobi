import '../config.js';
import { accessSync, constants, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR || resolve(root, 'data');
const results = [];
const add = (name, ok, note) => results.push({ name, ok, note });
add('node', Number(process.versions.node.split('.')[0]) >= 22, process.versions.node);
add('bot_token', /^\d+:[A-Za-z0-9_-]{20,}$/.test(process.env.BOT_TOKEN || ''), 'Value is never printed');
add('admins', /^\d+(,\s*\d+)*$/.test([process.env.ADMIN_IDS, process.env.ADMIN_ID].filter(Boolean).join(',')), 'ADMIN_IDS or ADMIN_ID required');
add('supplier', Boolean(process.env.AVIEDO_TOKEN && process.env.AVIEDO_SECRET), 'AVIEDO_TOKEN and AVIEDO_SECRET');
try { mkdirSync(dataDir, { recursive: true }); accessSync(dataDir, constants.W_OK); add('data_writable', true, dataDir); }
catch { add('data_writable', false, dataDir); }
add('persistent_storage_config', Boolean(process.env.DATA_DIR), 'On Railway, DATA_DIR must point to the mounted volume');
const hasDb = existsSync(resolve(dataDir, 'shop.db'));
const orphanWal = readdirSync(dataDir).some(name => /\.(sqlite|db)-wal$/.test(name)) && !hasDb;
add('database_files', !orphanWal, orphanWal ? 'WAL file without its main database: restore a consistent backup before launch' : hasDb ? 'Database exists' : 'No existing database; first launch creates an empty store');
console.log(JSON.stringify({ readOnly: true, checks: results }, null, 2));
if (results.some(result => !result.ok)) process.exitCode = 1;

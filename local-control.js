import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnv, saveEnv } from './env-file.js';

const root = dirname(fileURLToPath(import.meta.url));
const configIndex = process.argv.indexOf('--config-dir');
const configRoot = configIndex >= 0 ? resolve(process.argv[configIndex + 1]) : root;
process.chdir(configRoot);
const data = join(configRoot, 'data');
mkdirSync(data, { recursive: true });
const lockPath = join(data, 'local-control.lock');
const logPath = join(data, 'local-control.log');
const csrf = randomBytes(32).toString('hex');
let child = null, awake = null, restartTimer = null, exiting = false;
let botState = 'stopped', lastError = '', port = 0, setupBusy = false;
let currentEnv = readEnv();

function openLocalPage(url) {
  if (process.argv.includes('--open') && process.platform === 'win32') {
    const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url],
      { detached: true, windowsHide: true, stdio: 'ignore' });
    browser.on('error', () => {});
    browser.unref();
  }
}

function log(text) {
  let safe = String(text);
  const cfg = readEnv();
  for (const key of ['BOT_TOKEN', 'AVIEDO_TOKEN', 'AVIEDO_SECRET', 'OWNER_SETUP_SECRET']) {
    if (cfg[key]) safe = safe.split(cfg[key]).join('[REDACTED]');
  }
  safe = safe.replace(/bot\d{5,}:[A-Za-z0-9_-]+/g, 'bot[REDACTED]');
  if (existsSync(logPath) && readFileSync(logPath).length > 2_000_000) writeFileSync(logPath, '');
  appendFileSync(logPath, `${new Date().toISOString()} ${safe.trim()}\n`);
}

function keepAwake() {
  if (awake || process.platform !== 'win32') return;
  const script = readFileSync(join(root, 'keep-awake.ps1'), 'utf8');
  awake = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `& { ${script}\n } -OwnerProcessId ${process.pid}`],
    { windowsHide: true, stdio: 'ignore' });
  awake.on('error', () => { lastError = 'Не удалось включить защиту от сна. Проверь параметры питания Windows.'; });
  awake.on('exit', () => { awake = null; });
}

function releaseAwake() { if (awake) { awake.kill(); awake = null; } }

function startBot() {
  if (child || exiting) return;
  const env = readEnv();
  if (!env.BOT_TOKEN) throw new Error('Сначала подключи Telegram-бота.');
  if (!env.ADMIN_ID && !env.ADMIN_IDS && Number(env.OWNER_SETUP_EXPIRES || 0) < Date.now()) {
    env.OWNER_SETUP_SECRET = randomBytes(24).toString('base64url');
    env.OWNER_SETUP_EXPIRES = String(Date.now() + 15 * 60 * 1000);
    saveEnv(env);
  }
  currentEnv = env;
  botState = 'starting'; lastError = '';
  keepAwake();
  const proc = spawn(process.execPath, [join(root, 'bot-entry.js')], {
    cwd: configRoot, env: { ...process.env, ...env }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child = proc;
  proc.stdout.on('data', chunk => log(chunk));
  proc.stderr.on('data', chunk => log(chunk));
  proc.on('error', () => { lastError = 'Не удалось запустить процесс бота.'; });
  proc.on('exit', (code) => {
    if (child !== proc) return;
    child = null;
    releaseAwake();
    if (exiting || botState === 'stopping' || code === 0) { botState = 'stopped'; return; }
    if (code === 73) {
      botState = 'blocked'; lastError = 'Этот бот уже запущен где-то ещё. Останови другой экземпляр и нажми «Запустить».';
    } else if (code === 78) {
      botState = 'blocked'; lastError = 'Telegram отклонил токен. Проверь его в BotFather и подключи бота заново.';
    } else {
      botState = 'retrying'; lastError = 'Соединение прервано. Повторный запуск через 5 секунд.';
      restartTimer = setTimeout(() => { restartTimer = null; try { startBot(); } catch (error) { lastError = error.message; } }, 5000);
    }
  });
}

async function stopBot() {
  clearTimeout(restartTimer); restartTimer = null;
  botState = 'stopping';
  const proc = child;
  if (proc) {
    await new Promise(resolveStop => {
      const timer = setTimeout(() => { proc.kill(); resolveStop(); }, 12000);
      proc.once('exit', () => { clearTimeout(timer); resolveStop(); });
      if (proc.connected) proc.send({ type: 'shutdown' }); else proc.kill();
    });
  }
  child = null; releaseAwake(); botState = 'stopped';
}

async function status() {
  const env = readEnv();
  let ready = false;
  if (child && botState !== 'stopping') {
    try {
      const response = await fetch(`http://127.0.0.1:${env.PORT}/ready`, { signal: AbortSignal.timeout(1500) });
      const result = await response.json();
      ready = response.ok && result.bot?.ready === true;
      if (ready) botState = 'running';
      else if (botState === 'running') botState = 'starting';
    } catch { if (botState === 'running') botState = 'starting'; }
  }
  return { configured: Boolean(env.BOT_TOKEN), state: ready ? 'running' : botState,
    ownerConnected: Boolean(env.ADMIN_ID || env.ADMIN_IDS),
    connectCommand: env.OWNER_SETUP_SECRET && Number(env.OWNER_SETUP_EXPIRES) > Date.now()
      && !env.ADMIN_ID && !env.ADMIN_IDS ? '/connect ' + env.OWNER_SETUP_SECRET : null,
    supplierConfigured: Boolean(env.AVIEDO_TOKEN && env.AVIEDO_SECRET), lastError,
    localDatabase: 'База хранится на этом ПК. История со старого сервера ещё не импортирована.' };
}

async function configure(input) {
  if (setupBusy) throw new Error('Проверка уже выполняется.');
  if (typeof input.token !== 'string' || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(input.token.trim())) {
    throw new Error('Вставь полный токен, выданный BotFather.');
  }
  setupBusy = true;
  try {
    const token = input.token.trim();
    let me;
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
        signal: AbortSignal.timeout(15000), redirect: 'error',
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error('rejected');
      me = result.result;
    } catch { throw new Error('Не удалось проверить токен в Telegram. Проверь токен и подключение к интернету.'); }
    if (me.username?.toLowerCase() !== 'ysobishop_bot') {
      throw new Error('Это токен другого бота. Нужен токен @YsobiShop_bot.');
    }
    await stopBot();
    const env = readEnv();
    const supplierIndex = process.argv.indexOf('--supplier-env');
    if (supplierIndex >= 0 && process.argv[supplierIndex + 1]) {
      const supplier = readEnv(resolve(process.argv[supplierIndex + 1]));
      for (const key of ['AVIEDO_TOKEN', 'AVIEDO_SECRET']) if (!env[key] && supplier[key]) env[key] = supplier[key];
    }
    Object.assign(env, { BOT_TOKEN: token, DATA_DIR: data.replaceAll('\\', '/'),
      PORT: '31982', HEALTH_HOST: '127.0.0.1', NODE_ENV: 'production' });
    if (!env.ADMIN_ID && !env.ADMIN_IDS) {
      env.OWNER_SETUP_SECRET = randomBytes(24).toString('base64url');
      env.OWNER_SETUP_EXPIRES = String(Date.now() + 15 * 60 * 1000);
    }
    saveEnv(env);
    startBot();
  } finally { setupBusy = false; }
}

function reply(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const page = () => `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ysobi Shop — управление</title><style>
*{box-sizing:border-box}body{margin:0;background:#101116;color:#eee;font:16px/1.55 system-ui,sans-serif}main{max-width:710px;margin:6vh auto;padding:28px}h1{font-size:32px;margin:0 0 4px}.sub{color:#a7a9b6;margin:0 0 26px}section{background:#1a1c25;border:1px solid #303344;border-radius:16px;padding:24px;margin:16px 0}h2{font-size:19px;margin:0 0 14px}input{width:100%;background:#101116;border:1px solid #53566a;color:white;padding:13px;border-radius:9px;margin:8px 0 16px;font:inherit}button{background:#a8f083;border:0;padding:12px 18px;border-radius:9px;color:#162011;font:600 15px system-ui;cursor:pointer;margin:4px 6px 4px 0}button.secondary{background:#303344;color:#eee}button:disabled{opacity:.45;cursor:wait}.muted{color:#a7a9b6;font-size:14px}.error{color:#ffb5ac}code{word-break:break-all;display:block;background:#101116;padding:12px;border-radius:8px;font-size:14px}a{color:#b9f596}#owner{display:none}.status{font-size:20px;font-weight:600}label{display:block}
</style><main><h1>Ysobi Shop</h1><p class="sub">Магазин на твоём ПК · @YsobiShop_bot</p>
<section><h2>Состояние бота</h2><div class="status" id="state">Проверяем…</div><p id="error" class="error"></p><button id="start">Запустить</button><button class="secondary" id="stop">Остановить</button><p class="muted">Программа должна оставаться запущенной. Компьютер можно свернуть и выключить экран. Выключение ПК или ручной сон прерывают работу.</p></section>
<section id="setup"><h2>Подключить Telegram</h2><p>В BotFather открой <b>/mybots → @YsobiShop_bot → API Token</b>. Вставь токен ниже. Он сохранится только в локальных настройках и будет отправлен Telegram для проверки.</p>
<form id="form"><label>Токен BotFather<input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="123456789:…" required></label><button id="save">Подключить бота</button></form><p id="result" class="muted"></p></section>
<section id="owner"><h2>Подключить владельца</h2><p>Открой <a href="https://t.me/YsobiShop_bot" target="_blank" rel="noreferrer">@YsobiShop_bot</a> в личном чате и отправь эту команду:</p><code id="command"></code><p class="muted">Команда одноразовая. Владелец назначается только тому, кто знает этот код.</p></section>
<section><h2>Что уже подключено</h2><p id="supplier"></p><p class="muted">Оплата и автоматические закупки ещё не включены. Подключение Aviedo пока позволяет проверять товары и баланс через меню администратора.</p><p class="muted" id="database"></p></section>
<button class="secondary" id="exit">Закрыть программу и остановить бота</button></main><script>
const key=${JSON.stringify(csrf)};const $=id=>document.getElementById(id);let busy=false;
async function api(path,body){const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{'X-Local-Key':key,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const v=await r.json();if(!r.ok)throw Error(v.error||'Ошибка');return v}
async function refresh(){if(busy)return;try{const s=await api('status');const names={stopped:'Остановлен',starting:'Подключается к Telegram…',running:'Работает',retrying:'Восстанавливаем соединение…',blocked:'Требуется действие',stopping:'Останавливается…'};$('state').textContent=names[s.state]||s.state;$('error').textContent=s.lastError||'';$('owner').style.display=s.connectCommand?'block':'none';$('command').textContent=s.connectCommand||'';$('supplier').textContent=s.supplierConfigured?'Aviedo: ключи сохранены локально.':'Aviedo: ключи пока не найдены.';$('database').textContent=s.localDatabase;$('setup').querySelector('h2').textContent=s.configured?'Изменить подключение Telegram':'Подключить Telegram';$('start').disabled=!s.configured||['starting','running'].includes(s.state)}catch{}}
$('form').onsubmit=async e=>{e.preventDefault();busy=true;$('save').disabled=true;$('result').textContent='Проверяем токен в Telegram…';try{await api('setup',{token:$('token').value});$('token').value='';$('result').textContent='Telegram подключён. Следующий шаг — назначить владельца.'}catch(e){$('result').textContent=e.message}finally{busy=false;$('save').disabled=false;refresh()}};
for(const id of ['start','stop'])$(id).onclick=async()=>{try{await api(id,{});refresh()}catch(e){$('error').textContent=e.message}};
$('exit').onclick=async()=>{await api('exit',{});$('state').textContent='Программа закрыта';$('error').textContent='Эту вкладку можно закрыть.'};setInterval(refresh,2500);refresh();
</script></html>`;

const server = http.createServer(async (req, res) => {
  const expectedOrigin = `http://127.0.0.1:${port}`;
  if (req.headers.host !== `127.0.0.1:${port}` ||
      req.headers.origin && req.headers.origin !== expectedOrigin) return reply(res, 403, { error: 'Forbidden' });
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
    return res.end(page());
  }
  const received = Buffer.from(String(req.headers['x-local-key'] || ''));
  const expected = Buffer.from(csrf);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return reply(res, 403, { error: 'Forbidden' });
  try {
    if (req.url === '/api/status' && req.method === 'GET') return reply(res, 200, await status());
    if (req.method !== 'POST') return reply(res, 404, { error: 'Not found' });
    let body = '';
    for await (const part of req) {
      body += part;
      if (body.length > 8192) return reply(res, 413, { error: 'Слишком большой запрос.' });
    }
    const input = JSON.parse(body || '{}');
    if (req.url === '/api/setup') await configure(input);
    else if (req.url === '/api/start') startBot();
    else if (req.url === '/api/stop') await stopBot();
    else if (req.url === '/api/exit') { reply(res, 200, { ok: true }); void exit(); return; }
    else return reply(res, 404, { error: 'Not found' });
    reply(res, 200, { ok: true });
  } catch (error) { reply(res, 400, { error: error.message || 'Не удалось выполнить действие.' }); }
});

async function exit() {
  if (exiting) return;
  exiting = true;
  await stopBot();
  server.close();
  try { unlinkSync(lockPath); } catch {}
  process.exit(0);
}

if (existsSync(lockPath)) {
  try {
    const old = JSON.parse(readFileSync(lockPath, 'utf8'));
    process.kill(old.pid, 0);
    console.log(`YSOBI_LOCAL_URL=http://127.0.0.1:${old.port}`);
    openLocalPage(`http://127.0.0.1:${old.port}`);
    process.exit(0);
  } catch { try { unlinkSync(lockPath); } catch {} }
}
server.listen(0, '127.0.0.1', () => {
  port = server.address().port;
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, port }), { flag: 'wx' });
  console.log(`YSOBI_LOCAL_URL=http://127.0.0.1:${port}`);
  openLocalPage(`http://127.0.0.1:${port}`);
  if (currentEnv.BOT_TOKEN) { try { startBot(); } catch (error) { lastError = error.message; } }
});
process.once('SIGINT', () => void exit());
process.once('SIGTERM', () => void exit());

// Load configuration before modules that open SQLite or read environment variables.
try { process.loadEnvFile(); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

export function safeError(error) {
  let message = String(error?.description || error?.message || error || 'Unknown error');
  for (const key of ['BOT_TOKEN', 'AVIEDO_TOKEN', 'AVIEDO_SECRET', 'ADMIN_PANEL_PASSWORD']) {
    const secret = process.env[key];
    if (secret) message = message.split(secret).join('[REDACTED]');
  }
  return message.replace(/bot\d{5,}:[A-Za-z0-9_-]+/g, 'bot[REDACTED]').slice(0, 1000);
}

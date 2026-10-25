export function healthHandler(runtime) {
  return (req, res) => {
    if (!['/health', '/ready', '/status'].includes(req.url)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const bot = runtime.snapshot();
    const ready = bot.ready;
    res.writeHead(req.url === '/ready' && !ready ? 503 : 200,
      { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    // No credentials, database contents or internal error messages on public URLs.
    res.end(JSON.stringify({ status: ready ? 'ok' : 'degraded',
      uptime: Math.floor(process.uptime()), bot: { state: bot.state, ready,
        lastPollAt: bot.lastPollAt } }));
  };
}

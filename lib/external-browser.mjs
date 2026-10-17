import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const uuid = value => typeof value === 'string' && /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
const failure = message => Object.assign(new Error(message), { status: 400 });
const unavailable = () => Object.assign(new Error('Could not verify the Orca connection. Refresh the page and try again.'), { status: 503 });
function webURL(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('A valid web address is required.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 8192)
    throw failure('Only HTTP and HTTPS web addresses can be opened.');
  return url;
}

// Optional integration: never start Orca, invoke a shell, or open a browser on
// the Linux server. Only the runtime hosting this exact fbrowse page may open it.
export function createExternalBrowser({ run, env = { ...process.env }, platform = process.platform } = {}) {
  const command = env.ORCA_CLI_COMMAND || (env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : platform === 'linux' ? 'orca-ide' : 'orca');
  run ||= async args => {
    const { stdout } = await execute(command, args, { env, timeout: args[0] === 'open-url' ? 30000 : 5000,
      maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    const receipt = JSON.parse(stdout);
    if (!receipt.ok) throw unavailable();
    return receipt.result;
  };
  const clients = new Map();
  const marker = client => `globalThis.fbrowseBrowserClientId === ${JSON.stringify(client)}`;
  const matches = async (page, client) => {
    const value = (await run(['eval', '--page', page, '--expression', marker(client), '--json'])).result;
    return value === true || value === 'true';
  };
  function prune() {
    for (const [key, value] of clients) if (Date.now() - value.time > 24 * 3600_000) clients.delete(key);
    while (clients.size >= 128) clients.delete(clients.keys().next().value);
  }
  async function connect(data, origin) {
    const url = webURL(data.source_url);
    if (!uuid(data.client_id) || url.origin !== origin) throw failure('Connect from the current fbrowse page.');
    try {
      const { tabs } = await run(['tab', 'list', '--worktree', 'all', '--json']);
      const candidates = tabs.filter(tab => {
        try { return new URL(tab.url).origin === url.origin; } catch { return false; }
      });
      // A URL alone is insufficient: Chrome can show the same URL as Orca.
      // Match the random, per-document marker before claiming this caller.
      if (candidates.length > 8) return { connected: false };
      const found = (await Promise.all(candidates.map(async tab => {
        try { return tab.worktreeId && await matches(tab.browserPageId, data.client_id) ? tab : null; } catch { return null; }
      }))).filter(Boolean);
      if (found.length !== 1) return { connected: false };
      const tab = found[0];
      prune();
      clients.set(data.client_id, { page: tab.browserPageId, worktree: tab.worktreeId, origin, time: Date.now(), requests: new Map() });
      return { connected: true };
    } catch { /* An ordinary browser needs no Orca installation. */ }
    return { connected: false };
  }
  async function open(data, origin) {
    const url = webURL(data.url), client = clients.get(data.client_id);
    if (!uuid(data.request_id) || typeof data.background !== 'boolean' || url.origin === origin)
      throw failure('Check the external link request.');
    if (!client || client.origin !== origin) throw unavailable();
    const previous = client.requests.get(data.request_id);
    if (previous) {
      if (previous.url !== url.href || previous.background !== data.background) throw failure('This request has already been used.');
      return previous.result;
    }
    // Retain even failed/uncertain receipts: a network timeout after creation
    // must never be retried as a second tab or followed by a second popup.
    if (client.requests.size >= 256) throw unavailable();
    const result = (async () => {
      try {
        if (!await matches(client.page, data.client_id)) throw unavailable();
        const args = ['open-url', '--worktree', 'id:' + client.worktree, '--url', url.href, '--json'];
        const opened = await run(args);
        if (!opened.browserPageId) throw unavailable();
        let background = false;
        if (data.background) {
          // Older CLIs have no background-create flag. Restore the source only
          // after creation; failure here must not turn a successful open into a retry.
          try { await run(['tab', 'switch', '--page', client.page, '--json']); background = true; } catch {}
        }
        client.time = Date.now();
        return { opened: true, background, browser_page_id: opened.browserPageId };
      } catch { throw unavailable(); }
    })();
    client.requests.set(data.request_id, { url: url.href, background: data.background, result });
    return result;
  }
  return { connect, open };
}

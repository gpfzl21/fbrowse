import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { createExternalBrowser } from '../lib/external-browser.mjs';
import { startServer } from '../lib/server.mjs';

const origin = 'http://127.0.0.1:32123';
function fixture({ match = 'true', openError = false, switchError = false } = {}) {
  const calls = [], client = randomUUID();
  let currentMatch = match;
  const run = async args => {
    calls.push(args);
    if (args[0] === 'eval') return { result: currentMatch };
    if (args[1] === 'list') return { tabs: [
      { browserPageId: 'unrelated', url: 'https://example.com/', worktreeId: 'other' },
      { browserPageId: 'source', url: origin + '/?path=notes.md', worktreeId: 'repo::/actual/source workspace' },
    ] };
    if (args[0] === 'open-url') {
      if (openError) throw Error('transport lost after acceptance: PRIVATE_DETAIL');
      return { browserPageId: 'opened' };
    }
    if (switchError) throw Error('source focus unavailable');
    return {};
  };
  const browser = createExternalBrowser({ run });
  const connect = () => browser.connect({ client_id: client, source_url: origin + '/' }, origin);
  const open = (overrides = {}) => browser.open({ client_id: client, request_id: randomUUID(),
    url: 'https://arxiv.org/abs/2412.03104?q=a%20b#section', background: false, ...overrides }, origin);
  return { browser, client, calls, connect, open, setMatch: value => { currentMatch = value; } };
}

test('only the caller document can bind a runtime, even when another browser has the same URL', async () => {
  const f = fixture({ match: 'false' });
  assert.deepEqual(await f.connect(), { connected: false });
  await assert.rejects(f.open(), { status: 503 });
  assert.equal(f.calls.some(args => args[0] === 'open-url'), false);
  const absent = createExternalBrowser({ run: async () => { throw Error('ENOENT'); } });
  assert.deepEqual(await absent.connect({ source_url: origin, client_id: randomUUID() }, origin), { connected: false });
});

test('open uses the source worktree, preserves URL bytes, and replays one request without creating another tab', async () => {
  const f = fixture();
  assert.deepEqual(await f.connect(), { connected: true });
  const request_id = randomUUID();
  const results = await Promise.all([f.open({ request_id }), f.open({ request_id })]);
  assert.deepEqual(results, [{ opened: true, background: false, browser_page_id: 'opened' }, { opened: true, background: false, browser_page_id: 'opened' }]);
  assert.deepEqual(f.calls.filter(args => args[0] === 'open-url'), [
    ['open-url', '--worktree', 'id:repo::/actual/source workspace', '--url',
      'https://arxiv.org/abs/2412.03104?q=a%20b#section', '--json'],
  ]);
  await assert.rejects(f.open({ request_id, url: 'https://arxiv.org/abs/2210.03629' }), { status: 400 });
  await f.open({ background: true });
  assert.deepEqual(f.calls.at(-1), ['tab', 'switch', '--page', 'source', '--json']);
});

test('uncertain creation is never repeated, and a failed focus restore never retries a successful open', async () => {
  const f = fixture({ openError: true });
  await f.connect();
  const request_id = randomUUID();
  for (let i = 0; i < 2; i++) await assert.rejects(f.open({ request_id }), error => error.status === 503 && !error.message.includes('PRIVATE_DETAIL'));
  assert.equal(f.calls.filter(args => args[0] === 'open-url').length, 1);
  const focus = fixture({ switchError: true });
  await focus.connect();
  assert.deepEqual(await focus.open({ background: true }), { opened: true, background: false, browser_page_id: 'opened' });
  assert.equal(focus.calls.filter(args => args[0] === 'open-url').length, 1);
});

test('rejects invalid protocols, credentials, foreign bindings and stale source documents', async () => {
  const f = fixture();
  await assert.rejects(f.browser.connect({ client_id: f.client, source_url: 'https://foreign.test/' }, origin), { status: 400 });
  await f.connect();
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://name:secret@example.test', origin])
    await assert.rejects(f.open({ url }), { status: 400 });
  await assert.rejects(f.open({ request_id: '--url' }), { status: 400 });
  assert.equal(f.calls.some(args => args[0] === 'open-url'), false);
  // Navigation to another document revokes the per-page marker.
  const stale = fixture({ match: true });
  await stale.connect();
  stale.setMatch('false');
  await assert.rejects(stale.open(), { status: 503 });
  assert.equal(stale.calls.some(args => args[0] === 'open-url'), false);
  // A different client cannot borrow the connected worktree.
  await assert.rejects(stale.open({ client_id: randomUUID() }), { status: 503 });
});

test('external endpoint authenticates same-origin requests and accepts HTTPS/port-forward authorities', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fbrowse-external-api-'));
  const calls = [];
  const externalBrowser = { connect: async data => { calls.push(data); return { connected: false }; }, open: async data => { calls.push(data); return { opened: true }; } };
  const app = await startServer({ root, pdfjs: false, externalBrowser });
  try {
    const url = new URL(app.url), body = JSON.stringify({ action: 'open', url: 'https://arxiv.org/abs/2412.03104' });
    const post = headers => new Promise((resolve, reject) => {
      const request = http.request(app.url + 'api/external-browser', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } }, response => {
          response.resume();response.on('end', () => resolve({ status: response.statusCode }));
        });
      request.on('error', reject);request.end(body);
    });
    assert.equal((await post({})).status, 403);
    const headers = { 'X-Fbrowse-Token': app.info.config_token, Origin: url.origin };
    assert.equal((await post({ ...headers, Origin: 'https://foreign.test' })).status, 403);
    assert.equal((await post({ ...headers, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await post({ ...headers, Host: 'foreign.test' })).status, 403);
    assert.equal(calls.length, 0);
    assert.equal((await post(headers)).status, 200);
    assert.equal(calls.length, 1);
    assert.equal((await post({ ...headers, Origin: 'https://fbrowse.example:4431', Host: 'fbrowse.example:4431' })).status, 200);
    assert.equal(calls.length, 2);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

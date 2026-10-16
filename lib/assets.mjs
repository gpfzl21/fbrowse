import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// npm verifies the pinned KaTeX package at install time; all math assets are local.
export const MATH_ASSETS = path.dirname(createRequire(import.meta.url).resolve('katex'));

export const PDFJS_VERSION = '6.4.299';
export const PDFJS_SHA256 = 'f2245eb7ef3f674c872fe568a177bfec15874f5c034613e55d8e307f93ebd86d';
export const TEXT_ASSETS = {
  'highlight.js': ['@highlightjs/cdn-assets@11.12.0/highlight.min.js', '8ab71eb09c51f501e5e25157d9cff100e46cc29bcbfc744d0b746d451fca7f53'],
  'latex.js': ['@highlightjs/cdn-assets@11.12.0/languages/latex.min.js', '12c8743607535b327bcebd954b0228cf39b7844704123319a7fb594a7db94ce7'],
  'marked.js': ['marked@18.1.1/lib/marked.umd.js', 'b82b9334406d8bdd16b6236c08de1cb65b2a859873ca9503d9cc0b292ca3c12a'],
  'purify.js': ['dompurify@3.4.17/dist/purify.min.js', 'cd37898f9782adf54820c413191b5691803f0f137c799d6edcfd38523b4c2c31'],
};
const pending = new Map();
const digest = data => createHash('sha256').update(data).digest('hex');
async function cacheBase() {
  const base = path.resolve(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'project-file-browser');
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  return fs.realpath(base);
}

async function shared(key, operation) {
  if (!pending.has(key)) pending.set(key, operation().finally(() => pending.delete(key)));
  return pending.get(key);
}

async function download(url, limit, expected, timeout = 30_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok || !response.body) throw new Error(`Viewer download failed: HTTP ${response.status}`);
  const blocks = [];
  let size = 0;
  for await (const block of response.body) {
    size += block.length;
    if (size > limit) throw new Error('Viewer download exceeds expected size');
    blocks.push(block);
  }
  const data = Buffer.concat(blocks, size);
  if (digest(data) !== expected) throw new Error('Viewer asset checksum mismatch');
  return data;
}

async function regularData(file, maximum) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > maximum) throw new Error('Invalid viewer cache');
  return fs.readFile(file);
}

export async function textAsset(name) {
  if (!Object.hasOwn(TEXT_ASSETS, name)) throw Object.assign(new Error('Unknown text asset'), { code: 'ENOENT' });
  const [upstream, checksum] = TEXT_ASSETS[name];
  const target = path.join(await cacheBase(), 'text-assets', checksum + '.js');
  return shared(target, async () => {
    try { if (digest(await regularData(target, 2 * 1024 * 1024)) === checksum) return target; } catch {}
    const data = await download('https://cdn.jsdelivr.net/npm/' + upstream, 2 * 1024 * 1024, checksum, 20_000);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
    return target;
  });
}

function safeMember(name) {
  if (!name || name.includes('\\') || name.includes('\0') || path.isAbsolute(name) || name.split('/').includes('..'))
    throw new Error('Invalid PDF viewer archive path');
  return name;
}

async function verifiedCache(destination) {
  try {
    const manifest = JSON.parse(await regularData(path.join(destination, '.fbrowse-integrity.json'), 4 * 1024 * 1024));
    if (manifest.archive !== PDFJS_SHA256 || !manifest.files || !Object.hasOwn(manifest.files, 'web/viewer.html')) return false;
    const entries = Object.entries(manifest.files);
    if (entries.length > 20_000) return false;
    let size = 0;
    for (const [name, checksum] of entries) {
      safeMember(name);
      // Cached paths must not escape via changed parent-directory symlinks.
      const target = path.join(destination, name);
      if (await fs.realpath(target) !== target) return false;
      const data = await regularData(target, 64 * 1024 * 1024);
      size += data.length;
      if (size > 256 * 1024 * 1024 || digest(data) !== checksum) return false;
    }
    return true;
  } catch { return false; }
}

export async function preparePdfjs() {
  const base = await cacheBase();
  const legacy = path.join(base, `pdfjs-${PDFJS_VERSION}`);
  // Separate verified installs avoid replacing assets used by a running legacy server.
  const destination = path.join(base, `pdfjs-${PDFJS_VERSION}-node`);
  return shared(destination, async () => {
    for (const candidate of [destination, legacy]) if (await verifiedCache(candidate)) return candidate;
    const data = await download(`https://github.com/mozilla/pdf.js/releases/download/v${PDFJS_VERSION}/pdfjs-${PDFJS_VERSION}-dist.zip`,
      64 * 1024 * 1024, PDFJS_SHA256);
    const { unzipSync } = await import('fflate');
    let expanded = 0, count = 0;
    const files = unzipSync(data, { filter(member) {
      safeMember(member.name);
      expanded += member.originalSize;
      if (++count > 20_000 || expanded > 256 * 1024 * 1024 || member.originalSize > 64 * 1024 * 1024)
        throw new Error('PDF viewer extraction exceeds expected size');
      return !member.name.endsWith('/');
    } });
    if (!files['web/viewer.html']) throw new Error('PDF viewer archive is incomplete');
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
    const temporary = await fs.mkdtemp(path.join(base, '.pdfjs-'));
    try {
      const hashes = {};
      for (const [name, content] of Object.entries(files)) {
        safeMember(name);
        const target = path.join(temporary, name);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, { flag: 'wx', mode: 0o600 });
        hashes[name] = digest(content);
      }
      await fs.writeFile(path.join(temporary, '.fbrowse-integrity.json'), JSON.stringify({ archive: PDFJS_SHA256, files: hashes }), { mode: 0o600 });
      try { await fs.rename(temporary, destination); }
      catch (error) {
        if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        if (await verifiedCache(destination)) return destination;
        // Preserve an existing cache in use; a unique verified directory is safe to serve.
        const alternate = `${destination}-${randomUUID()}`;
        await fs.rename(temporary, alternate);
        return alternate;
      }
      return destination;
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });
}

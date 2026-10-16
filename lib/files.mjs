import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export const EXCLUDED = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', '.cache']);
export const LANGUAGES = Object.fromEntries(Object.entries({
  python: 'py pyw', javascript: 'js mjs cjs jsx', typescript: 'ts tsx', bash: 'sh bash zsh',
  json: 'json jsonl', yaml: 'yaml yml', ini: 'toml ini cfg', css: 'css', xml: 'xml html htm',
  c: 'c h', cpp: 'cc cpp hpp', java: 'java', go: 'go', rust: 'rs', ruby: 'rb', php: 'php',
  sql: 'sql', latex: 'tex sty cls', markdown: 'md markdown mdown', diff: 'diff patch',
  r: 'r', swift: 'swift', kotlin: 'kt',
}).flatMap(([language, extensions]) => extensions.split(' ').map(extension => ['.' + extension, language])));
export const TYPES = {
  pdf: new Set(['.pdf']), html: new Set(['.html', '.htm']), markdown: new Set(['.md', '.markdown', '.mdown']),
};
TYPES.code = new Set(Object.keys(LANGUAGES).filter(extension => !TYPES.html.has(extension) && !TYPES.markdown.has(extension)));

const MIME = {
  '.pdf': 'application/pdf', '.html': 'text/html', '.htm': 'text/html', '.xhtml': 'application/xhtml+xml',
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.json': 'application/json', '.map': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain',
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.mdown': 'text/markdown', '.csv': 'text/csv',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/vnd.microsoft.icon',
  '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.apng': 'image/apng',
  '.mp3': 'audio/mpeg', '.wav': 'audio/x-wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.opus': 'audio/ogg', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.bcmap': 'application/octet-stream', '.zip': 'application/zip',
};
export function mimeType(file) {
  const extension = path.extname(file).toLowerCase();
  return MIME[extension] || (LANGUAGES[extension] ? 'text/plain' : 'application/octet-stream');
}
export function failure(message, status = 403) { return Object.assign(new Error(message), { status }); }
export function inside(boundary, target) {
  const relative = path.relative(boundary, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export function visible(relative, showHidden = false) {
  return relative.split('/').every(part => !EXCLUDED.has(part) && (showHidden || !part.startsWith('.') || part === '.'));
}

export async function resolvePath(boundary, relative, showHidden = false) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.includes('\0') ||
      path.isAbsolute(relative) || relative.split('/').includes('..') || !visible(relative, showHidden))
    throw failure('Path is excluded');
  // Do not silently follow a registered mount/root replaced by a symlink.
  if (await fs.realpath(boundary) !== boundary) throw failure('Root path was replaced with a symlink');
  const target = await fs.realpath(path.join(boundary, relative));
  if (!inside(boundary, target) || !visible(path.relative(boundary, target), showHidden))
    throw failure('Path is outside root or excluded');
  return target;
}

export async function entry(target, relative, rootId, boundary) {
  const info = await fs.stat(target);
  if (!info.isDirectory() && !info.isFile()) throw failure('Not a regular file or directory');
  const extension = path.extname(relative).toLowerCase();
  let category = Object.entries(TYPES).find(([, extensions]) => extensions.has(extension))?.[0] || 'text';
  if (category === 'text' && /^(image|audio|video)\//.test(mimeType(target))) category = 'media';
  return { name: path.basename(relative) || path.basename(boundary), path: relative, root_id: rootId,
    kind: info.isDirectory() ? 'directory' : 'file', size: info.size, mtime: info.mtimeMs / 1000, category };
}

export function entryOrder(a, b) {
  return Number(a.kind !== 'directory') - Number(b.kind !== 'directory') ||
    (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0);
}

// Verify the opened descriptor as well as the requested path, closing symlink-swap races.
export async function openFile(boundary, relative, showHidden = false) {
  const target = await resolvePath(boundary, relative, showHidden);
  const file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw failure('Not a regular file');
    const actual = await fs.realpath(`/proc/self/fd/${file.fd}`);
    if (!inside(boundary, actual) || !visible(path.relative(boundary, actual), showHidden) ||
        await fs.realpath(boundary) !== boundary) throw failure('Opened file is outside root');
    return { file, info, target };
  } catch (error) { await file.close(); throw error; }
}

export async function textPreview(boundary, relative, showHidden = false) {
  const { file } = await openFile(boundary, relative, showHidden);
  let content;
  try { content = await file.readFile(); } finally { await file.close(); }
  let text, encoding = 'UTF-8';
  try {
    if (content.subarray(0, 4).equals(Buffer.from([0xff, 0xfe, 0, 0])) ||
        content.subarray(0, 4).equals(Buffer.from([0, 0, 0xfe, 0xff]))) {
      encoding = 'UTF-32';
      if ((content.length - 4) % 4) throw new Error('Truncated UTF-32');
      const little = content[0] === 0xff;
      const chunks = [];
      for (let offset = 4; offset < content.length; offset += 4) {
        const point = little ? content.readUInt32LE(offset) : content.readUInt32BE(offset);
        if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw new Error('Invalid UTF-32');
        chunks.push(String.fromCodePoint(point));
      }
      text = chunks.join('');
    } else if (content.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) ||
               content.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
      encoding = 'UTF-16';
      text = new TextDecoder(content[0] === 0xff ? 'utf-16le' : 'utf-16be', { fatal: true }).decode(content);
    } else {
      if (content.subarray(0, 8192).includes(0)) throw new Error('Binary file');
      text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    }
    if (text.includes('\0')) throw new Error('Binary file');
  } catch { throw failure('텍스트로 표시할 수 없는 파일입니다. UTF-8/UTF-16/UTF-32 텍스트를 지원합니다. 원본 링크를 사용하세요.', 415); }
  const extension = path.extname(relative).toLowerCase(), name = path.basename(relative).toLowerCase();
  return { text: text.replace(/\r\n?/g, '\n'), language: LANGUAGES[extension] ||
    (['makefile', 'gnumakefile'].includes(name) ? 'makefile' : name === 'dockerfile' ? 'dockerfile' : ''),
    markdown: TYPES.markdown.has(extension), encoding };
}

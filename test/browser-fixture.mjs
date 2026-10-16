// Temporary fixtures only. No Python, shell helpers, or browser automation at runtime.
import { access, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { PDFJS_VERSION } from '../lib/assets.mjs';

function pdfBytes() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream'];
  let data = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(data));
    data += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = Buffer.byteLength(data);
  data += 'xref\n0 5\n0000000000 65535 f \n';
  data += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(data + `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
}

const existingCache = path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'project-file-browser');
const base = await mkdtemp(path.join(tmpdir(), 'fbrowse-browser-'));
let instance;
let closing;
async function close() {
  if (closing) return closing;
  closing = (async () => {
    try { await instance?.close(); }
    finally { await rm(base, { recursive: true, force: true }); }
  })();
  return closing;
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => close().then(() => process.exit(0), error => { console.error(error); process.exit(1); }));
}

try {
  for (const [key, directory] of Object.entries({ HOME: 'home', XDG_CONFIG_HOME: 'config', XDG_STATE_HOME: 'state', XDG_CACHE_HOME: 'cache' })) {
    process.env[key] = path.join(base, directory);
    await mkdir(process.env[key], { recursive: true });
  }
  // Reuse prepared viewer assets in an isolated copy, without changing the user's cache.
  try { await cp(existingCache, path.join(process.env.XDG_CACHE_HOME, 'project-file-browser'), { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const roots = Object.fromEntries(['project', 'papers', 'results'].map(name => [name, path.join(base, name)]));
  const lines = ['message = "' + 'abcdefghij '.repeat(50) + '"', 'def after_long():',
    '\treturn "' + '한글 탭 문자열 '.repeat(40) + '"', '', 'class AfterUnicode:',
    '\tpass', '', 'triple = """' + 'long string '.repeat(40),
    '여러 줄 문자열 '.repeat(40), '"""', 'def after_multiline():', '    return 1', ''];
  for (const [name, directory] of Object.entries(roots)) {
    await mkdir(directory);
    const fixtures = {
      'same.txt': name,
      'sample.py': lines.join('\n'),
      'README.md': '# 제목\n\n[동일 파일](same.txt)\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>window.PWNED=1</script>\n<img src="missing.png" onerror="window.PWNED=2">\n<a href="javascript:window.PWNED=3">unsafe</a>\n',
      'page.html': '<link rel="stylesheet" href="style.css"><h1>fixture</h1><script>parent.DOCUMENT_SCRIPT_RAN=true</script><script src="script.js"></script>',
      'style.css': 'h1 {color: rgb(1, 2, 3)}',
      'script.js': 'parent.EXTERNAL_DOCUMENT_SCRIPT_RAN=true;',
      'sample.pdf': pdfBytes(),
      'highlight-limit.py': '#'.repeat(300000),
      'large.py': '#'.repeat(300001),
      'markdown-limit.md': '# ' + 'x'.repeat(299998),
      'large.md': '# ' + 'x'.repeat(299999),
      'gutter-limit.txt': '\n'.repeat(19999),
      'many-lines.txt': '\n'.repeat(20000),
      'blank-tabs.py': '\n\n\t\n\t# 한글\nvalue = """first\n\n\tthird\n"""\n\nclass Final:\n\tpass\n\n',
    };
    await Promise.all(Object.entries(fixtures).map(([file, value]) => writeFile(path.join(directory, file), value)));
    await mkdir(path.join(directory, 'nested'));
    await writeFile(path.join(directory, 'nested', 'README.md'), '# Nested\n\n[동일 파일](../same.txt)\n\n![asset](../image.svg)\n');
    await writeFile(path.join(directory, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
  }
  await mkdir(path.join(roots.papers, '하위 폴더'));
  await writeFile(path.join(roots.papers, '하위 폴더', 'marker.txt'), 'inside folder');
  await mkdir(path.join(roots.papers, '.hidden-folder'));
  const cacheDirectory = path.join(process.env.XDG_CACHE_HOME, 'project-file-browser');
  let cachedPdfjs = false;
  for (const viewer of [`pdfjs-${PDFJS_VERSION}-node`, `pdfjs-${PDFJS_VERSION}`]) {
    try {
      await access(path.join(cacheDirectory, viewer, 'web', 'viewer.html'));
      await access(path.join(cacheDirectory, viewer, '.fbrowse-integrity.json'));
      cachedPdfjs = true;
    }
    catch {}
  }
  instance = await startServer({ root: roots.project, host: '127.0.0.1', port: 0, pdfjs: cachedPdfjs });
  console.log(JSON.stringify({ url: instance.url.endsWith('/') ? instance.url : instance.url + '/', ...roots, pdfjs: instance.info.pdfjs }));
} catch (error) {
  console.error(error);
  await close();
  process.exitCode = 1;
}

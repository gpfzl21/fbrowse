// Temporary fixtures only. No Python, shell helpers, or browser automation at runtime.
import { access, cp, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../lib/server.mjs';
import { PDFJS_VERSION } from '../lib/assets.mjs';
const execFileAsync = promisify(execFile);

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
      'math.md': [
        '# 수식 테스트',
        '달러: $E=mc^2$, 괄호: \\(a_i + b_i\\).',
        '$$\\frac{1}{2} < x \\land y$$',
        '\\[\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\\]',
        '\\begin{align}\nx &= 1 \\\\\ny &= 2\n\\end{align}',
        '\\begin{equation*}a^2+b^2=c^2\\end{equation*}',
        '```math\n\\begin{pmatrix}1 & 2 \\\\ 3 & 4\\end{pmatrix}\n```',
        '> 인용문 안의 \\(x_1\\)과 **굵게 $x_2$**.',
        '| 수식 | 설명 |\n|---|---|\n| $x_i$ | 아래 첨자 |',
        'Inline display $$x^2$$ and \\[y^2\\].',
        '코드 `$x$`와 `\\(x\\)`는 원문 그대로.',
        '```python\nvalue = "$x$ and \\\\(x\\\\)"\n```',
        '<code>$raw$</code>',
        '가격 $5 and $10, 이스케이프 \\$20, 미완성 $x + 1.',
        '$\\href{javascript:window.MATH_PWNED=1}{bad}$',
        '$\\includegraphics{https://example.invalid/must-not-load.png}$',
        '$\\notARealCommand{x}$',
        '$z+1$',
      ].join('\n\n') + '\n',
      'math-environments.md': ['equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*', 'gather', 'gather*']
        .map(env => `\\begin{${env}}${env.startsWith('alignat') ? '{2}' : ''}x${env.startsWith('align') ? '&' : ''}=1\\end{${env}}`).join('\n\n'),
      'math-broken.md': '# 미완성 수식\n\n$$' + '\\'.repeat(50000) + '\n\n' + '\\('.repeat(10000),
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
  if (process.env.FBROWSE_GIT_FIXTURE === '1') {
    const git = (root, ...args) => execFileAsync('git', ['-C', root, ...args], { env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Browser Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Browser Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    } });
    for (const root of [roots.project, roots.results]) {
      await git(root, 'init', '-b', 'browser-fixture');
      await mkdir(path.join(root, 'changes'));
      for (const file of ['mixed.txt', 'deleted.txt', 'removed.txt', 'old-name.txt', 'conflict.txt'])
        await writeFile(path.join(root, 'changes', file), 'baseline ' + file + '\n');
      await writeFile(path.join(root, 'changes', 'binary.bin'), Buffer.from([0, 1, 2]));
      await symlink('same.txt', path.join(root, 'file-link.txt'));
      await symlink('changes', path.join(root, 'directory-link'));
      await git(root, 'add', '.');
      await git(root, 'commit', '-qm', 'temporary browser fixture baseline');
    }
    // A real merge conflict, created before applying the remaining fixture changes.
    await git(roots.project, 'checkout', '-qb', 'other');
    await writeFile(path.join(roots.project, 'changes', 'conflict.txt'), 'other side\n');
    await git(roots.project, 'add', 'changes/conflict.txt');
    await git(roots.project, 'commit', '-qm', 'other side');
    await git(roots.project, 'checkout', '-q', 'browser-fixture');
    await writeFile(path.join(roots.project, 'changes', 'conflict.txt'), 'our side\n');
    await git(roots.project, 'add', 'changes/conflict.txt');
    await git(roots.project, 'commit', '-qm', 'our side');
    await git(roots.project, 'merge', '--no-edit', 'other').catch(() => {});
    await writeFile(path.join(roots.project, 'changes', 'mixed.txt'), 'staged version\n++literal\n<script>window.DIFF_PWNED=1</script>\n');
    await git(roots.project, 'add', 'changes/mixed.txt');
    await writeFile(path.join(roots.project, 'changes', 'mixed.txt'), 'working version\n--literal\n<img src=x onerror="window.DIFF_PWNED=2">\n');
    await git(roots.project, 'mv', 'changes/old-name.txt', 'changes/new-name.txt');
    await git(roots.project, 'rm', 'changes/deleted.txt');
    await unlink(path.join(roots.project, 'changes', 'removed.txt'));
    await writeFile(path.join(roots.project, 'changes', 'binary.bin'), Buffer.from([0, 4, 5]));
    await writeFile(path.join(roots.project, 'changes', 'added.txt'), 'added file\n');
    await git(roots.project, 'add', 'changes/added.txt');
    await writeFile(path.join(roots.project, 'untracked <& 한글.txt'), '<script>window.DIFF_PWNED=3</script>\n');
    await mkdir(path.join(roots.project, 'untracked-folder'));
    await writeFile(path.join(roots.project, 'untracked-folder', 'child.txt'), 'untracked child\n');
    await writeFile(path.join(base, 'outside-secret.txt'), 'OUTSIDE_SECRET_NEVER_RENDER');
    await symlink('../outside-secret.txt', path.join(roots.project, 'outside-link.txt'));
    await symlink('missing-target', path.join(roots.project, 'broken-link.txt'));
    await writeFile(path.join(roots.results, 'same.txt'), 'other repository change');
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

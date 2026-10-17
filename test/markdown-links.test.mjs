import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveMarkdownLink } from '../lib/markdown-links.mjs';

test('Markdown links resolve against the document and map into registered roots', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fbrowse-markdown-links-'));
  try {
    const roots = Object.fromEntries(['project', 'other'].map(id => [id, { path: path.join(base, id) }]));
    await fs.mkdir(path.join(roots.project.path, 'docs'), { recursive: true });
    await fs.mkdir(path.join(roots.other.path, 'nested'), { recursive: true });
    await fs.writeFile(path.join(roots.project.path, 'docs/source.md'), '# Source');
    await fs.writeFile(path.join(roots.project.path, 'same.txt'), 'project');
    const target = path.join(roots.other.path, 'nested/한글 %.md');
    await fs.writeFile(target, '# Target');
    const resolve = (href, showHidden = false) => resolveMarkdownLink(roots, 'project', 'docs/source.md', href, showHidden);
    const expected = ['other', 'nested/한글 %.md'];
    for (const href of ['../../other/nested/한글%20%25.md', '..%2F..%2Fother%2Fnested%2F한글%20%25.md',
      encodeURI(target), pathToFileURL(target).href, '/roots/other/files/nested/한글%20%25.md',
      '/?root=other&path=nested%2F한글%20%25.md', '/_preview?root=other&path=nested%2F한글%20%25.md']) {
      const result = await resolve(href + '#section');
      assert.deepEqual([result.entry.root_id, result.entry.path], expected, href);
      assert.equal(result.hash, '#section');
      assert.equal(result.root_path, roots.other.path);
      assert.equal(result.source_root_path, roots.project.path);
    }
    for (const href of ['../same.txt', '/files/same.txt', '/roots/project/files/same.txt']) {
      assert.equal((await resolve(href)).entry.path, 'same.txt');
    }
    // A nested registered root is the most natural sidebar location; an explicit
    // app URL can still select a particular root when boundaries overlap.
    roots.nested = { path: path.join(roots.project.path, 'subproject') };
    await fs.mkdir(roots.nested.path);
    await fs.writeFile(path.join(roots.nested.path, 'target.md'), '# Nested root');
    assert.equal((await resolve('../subproject/target.md')).entry.root_id, 'nested');
    assert.equal((await resolve('/roots/project/files/subproject/target.md')).entry.root_id, 'project');
    assert.equal((await resolve('../../other/nested/')).entry.kind, 'directory');
    assert.equal((await resolve('../../other/')).entry.path, '');
    await fs.symlink(roots.other.path, path.join(roots.project.path, 'docs/linked'));
    await fs.symlink(target, path.join(roots.project.path, 'docs/linked.md'));
    for (const href of ['linked/nested/한글%20%25.md', 'linked.md']) {
      const result = await resolve(href);
      assert.deepEqual([result.entry.root_id, result.entry.path], expected);
    }
    // Equal filenames elsewhere never cause a missing relative link to open a different file.
    await assert.rejects(resolve('same.txt'), { code: 'ENOENT' });
    const outside = path.join(base, 'unregistered.txt');
    await fs.writeFile(outside, 'outside');
    await assert.rejects(resolve(outside), /Manage Roots/);
    await fs.symlink(outside, path.join(roots.project.path, 'docs/outside.md'));
    await assert.rejects(resolve('outside.md'), /Manage Roots/);
    await fs.writeFile(path.join(roots.other.path, '.hidden.md'), 'hidden');
    await assert.rejects(resolve('../../other/.hidden.md'), { status: 403 });
    assert.equal((await resolve('../../other/.hidden.md', true)).entry.path, '.hidden.md');
    await fs.mkdir(path.join(roots.other.path, 'node_modules'));
    await fs.writeFile(path.join(roots.other.path, 'node_modules/secret.md'), 'excluded');
    await assert.rejects(resolve('../../other/node_modules/secret.md', true), { status: 403 });
    await fs.symlink(target, path.join(roots.project.path, 'docs/.hidden-link'));
    await assert.rejects(resolve('.hidden-link'), { status: 403 });
    for (const href of ['javascript:alert(1)', 'https://example.com/file.md', '//example.com/file.md',
      'file://remote/tmp/file.md', 'bad%00.md', 'bad%5Cname.md', 'bad\\name.md']) {
      await assert.rejects(resolve(href), undefined, href);
    }
    await assert.rejects(resolve('/roots/project/files/../../other/nested/한글%20%25.md'), { status: 403 });
    await fs.rename(roots.other.path, path.join(base, 'disconnected'));
    await fs.symlink(path.join(base, 'disconnected'), roots.other.path);
    await assert.rejects(resolve('../../other/nested/한글%20%25.md'));
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

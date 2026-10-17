import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import fsNative from 'node:fs';
import { constants } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { filesystemAction, filesystemInfo } from '../lib/filesystem-actions.mjs';
import { readEditor, saveEditor, setEditorView } from '../lib/editor.mjs';
import { withFilesystemLock, withFilesystemLocks } from '../lib/editor-locks.mjs';

const run = promisify(execFile);
async function fixture(callback, showHidden = false) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fbrowse-fs-actions-'));
  const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = path.join(base, key);
  const root = path.join(base, 'root'), outside = path.join(base, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  const get = async () => root;
  const info = relative => filesystemInfo(get, relative, 'project', showHidden);
  const action = async (type, relative, extra = {}) => filesystemAction(get, {
    action: type, root: 'project', ...(type === 'mkdir' ? { parent: relative } :
      { path: relative, expected_version: (await info(relative)).version }), ...extra,
  }, showHidden);
  try { await callback({ base, root, outside, get, info, action }); }
  finally {
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    await fs.rm(base, { recursive: true, force: true });
  }
}

async function patch(object, key, wrap, callback) {
  const original = object[key]; object[key] = wrap(original); syncBuiltinESMExports();
  try { await callback(); }
  finally { object[key] = original; syncBuiltinESMExports(); }
}

test('copy/paste preserves source and binds both registered roots', { timeout: 120_000 }, async t => {
  const copyRequest = async (get, sourceRoot, sourcePath, destinationRoot, parent = '', extra = {}) => ({
    action: 'copy', root: destinationRoot, parent, root_path: await get(destinationRoot),
    source_root: sourceRoot, source_path: sourcePath, source_root_path: await get(sourceRoot),
    expected_version: (await filesystemInfo(() => get(sourceRoot), sourcePath, sourceRoot)).version, ...extra,
  });
  const execute = (get, data) => filesystemAction(() => get(data.root), data, false, null, null,
    { getSourceBoundary: () => get(data.source_root) });

  await t.test('same folder, other folder and cross-root copies keep both names, bytes and hidden descendants', () => fixture(async ({ root, outside }) => {
    const get = async id => id === 'project' ? root : outside;
    await fs.mkdir(path.join(root, 'target'));
    await fs.writeFile(path.join(root, '文書.tar.gz'), 'DISK\r\n', { mode: 0o640 });
    const original = await readEditor(root, '文書.tar.gz');
    const unsavedDraft = original.text + 'UNSAVED'; assert.notEqual(unsavedDraft, original.text);
    const same = await copyRequest(get, 'project', '文書.tar.gz', 'project');
    const copied = await execute(get, same), again = await execute(get, same);
    assert.equal(copied.path, '文書.tar copy.gz'); assert.equal(again.path, '文書.tar copy 2.gz');
    const other = await execute(get, await copyRequest(get, 'project', '文書.tar.gz', 'project', 'target'));
    assert.equal(other.path, 'target/文書.tar.gz');
    assert.equal((await execute(get, await copyRequest(get, 'project', '文書.tar.gz', 'external'))).path, '文書.tar.gz');
    for (const file of [path.join(root, copied.path), path.join(root, again.path), path.join(root, other.path), path.join(outside, '文書.tar.gz')]) {
      assert.equal(await fs.readFile(file, 'utf8'), 'DISK\r\n');
      assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
    }
    assert.equal((await filesystemInfo(() => get('project'), '文書.tar.gz', 'project')).version, same.expected_version);
    await fs.mkdir(path.join(root, 'tree', '.git'), { recursive: true });
    await fs.writeFile(path.join(root, 'tree', '.git', 'saved'), 'HIDDEN');
    await fs.writeFile(path.join(outside, 'canary'), 'CANARY');
    await fs.symlink(outside, path.join(root, 'tree', 'outside'));
    await fs.symlink('.', path.join(root, 'tree', 'cycle'));
    const tree = await execute(get, await copyRequest(get, 'project', 'tree', 'external'));
    assert.equal(tree.source_root_id, 'project'); assert.equal(tree.source_path, 'tree');
    assert.equal(await fs.readFile(path.join(outside, tree.path, '.git', 'saved'), 'utf8'), 'HIDDEN');
    assert.equal(await fs.readlink(path.join(outside, tree.path, 'outside')), outside);
    assert.equal(await fs.readlink(path.join(outside, tree.path, 'cycle')), '.');
    assert.equal(await fs.readFile(path.join(outside, 'canary'), 'utf8'), 'CANARY');
    const second = await execute(get, await copyRequest(get, 'project', 'tree', 'external'));
    assert.equal(second.path, 'tree copy');
    assert.equal((await fs.lstat(path.join(outside, 'tree', 'outside'))).isSymbolicLink(), true);
  }));

  await t.test('large saved files use bounded reads and preserve exact binary bytes', () => fixture(async ({ root, outside }) => {
    const get = async id => id === 'project' ? root : outside;
    const bytes = Buffer.alloc(9 * 1024 * 1024 + 137);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
    await fs.writeFile(path.join(root, 'large.bin'), bytes);
    const data = await copyRequest(get, 'project', 'large.bin', 'external');
    let reads = 0;
    await patch(fsPromises, 'open', original => async (...args) => {
      const file = await original(...args), read = file.read.bind(file);
      file.read = (...params) => {
        assert.ok(params[2] <= 256 * 1024, 'copy reads at most 256 KiB'); reads++;
        return read(...params);
      };
      return file;
    }, async () => assert.equal((await execute(get, data)).path, 'large.bin'));
    assert.ok(reads > 64);
    assert.deepEqual(await fs.readFile(path.join(outside, 'large.bin')), bytes);
    assert.deepEqual(await fs.readFile(path.join(root, 'large.bin')), bytes);
  }));

  await t.test('stale files and root aliases reject; directory references copy current nested saved bytes at Paste', () => fixture(async ({ root, outside }) => {
    const get = async id => id === 'external' ? outside : root;
    await fs.mkdir(path.join(root, 'tree', 'nested'), { recursive: true });
    await fs.writeFile(path.join(root, 'tree', 'nested', 'file'), 'ORIGINAL');
    const folder = await copyRequest(get, 'project', 'tree', 'external');
    const file = await copyRequest(get, 'project', 'tree/nested/file', 'external');
    await fs.writeFile(path.join(root, 'tree', 'nested', 'file'), 'CHANGED');
    await assert.rejects(execute(get, file), { status: 409 });
    const fresh = await copyRequest(get, 'project', 'tree/nested/file', 'external');
    await assert.rejects(execute(get, { ...fresh, source_root: 'alias' }), { status: 409 });
    assert.deepEqual(await fs.readdir(outside), []);
    await execute(get, folder);
    assert.equal(await fs.readFile(path.join(outside, 'tree', 'nested', 'file'), 'utf8'), 'CHANGED');
  }));

  await t.test('descendant/alias parents, linked parents, read-only, special objects and hidden boundaries reject', () => fixture(async ({ root, outside }) => {
    await fs.mkdir(path.join(root, 'tree', 'nested'), { recursive: true });
    await fs.writeFile(path.join(root, 'tree', 'file'), 'SOURCE');
    await fs.writeFile(path.join(outside, 'canary'), 'CANARY');
    const get = async id => id === 'external' ? outside : id === 'alias' ? path.join(root, 'tree', 'nested') : root;
    for (const [destination, parent] of [['project', 'tree'], ['project', 'tree/nested'], ['alias', '']])
      await assert.rejects(execute(get, await copyRequest(get, 'project', 'tree', destination, parent)), { status: 403 });
    await fs.symlink(outside, path.join(root, 'linked'));
    const valid = await copyRequest(get, 'project', 'tree/file', 'project');
    for (const parent of ['linked', 'missing', 'tree/file', '../outside', '/tmp', '.git', '.hidden', 'node_modules'])
      await assert.rejects(execute(get, { ...valid, parent }), error => [400, 403, 409].includes(error.status));
    for (const source_path of ['', '../outside/canary', '.git/file', '.hidden'])
      await assert.rejects(execute(get, { ...valid, source_path }), error => [400, 403].includes(error.status));
    await fs.mkdir(path.join(root, 'readonly'), { mode: 0o555 });
    await assert.rejects(execute(get, { ...valid, parent: 'readonly' }), { status: 403 });
    await run('mkfifo', [path.join(root, 'tree', 'fifo')]);
    await assert.rejects(execute(get, { ...valid, source_path: 'tree/fifo' }), { status: 403 });
    assert.equal(await fs.readFile(path.join(outside, 'canary'), 'utf8'), 'CANARY');
    assert.deepEqual(await fs.readdir(outside), ['canary']);
    await fs.chmod(path.join(root, 'readonly'), 0o755);
  }));

  await t.test('mapping changes while waiting for locks reject without copying to either mapping', () => fixture(async ({ root, outside, base }) => {
    const third = path.join(base, 'third'); await fs.mkdir(third);
    await fs.writeFile(path.join(root, 'source'), 'SOURCE');
    let destination = outside;
    const get = async id => id === 'project' ? root : destination;
    const data = await copyRequest(get, 'project', 'source', 'external');
    let pending;
    await withFilesystemLock(outside, async () => {
      pending = execute(get, data);
      await new Promise(resolve => setTimeout(resolve, 40));
      destination = third;
    });
    await assert.rejects(pending, { status: 409 });
    assert.deepEqual(await fs.readdir(outside), []); assert.deepEqual(await fs.readdir(third), []);
  }));

  await t.test('shallow directory info stays bounded while Paste rejects an over-depth tree before creating output', () => fixture(async ({ root, outside }) => {
    const get = async id => id === 'project' ? root : outside;
    let directory = path.join(root, 'deep'); await fs.mkdir(directory);
    for (let level = 0; level < 129; level++) {
      directory = path.join(directory, 'd'); await fs.mkdir(directory);
    }
    const data = await copyRequest(get, 'project', 'deep', 'external');
    await assert.rejects(execute(get, data), { status: 413 });
    assert.deepEqual(await fs.readdir(outside), []);
    assert.equal((await fs.stat(directory)).isDirectory(), true);
  }));

  await t.test('opposite cross-root copies and alias root locks finish without deadlock', () => fixture(async ({ root, outside }) => {
    const get = async id => id === 'external' ? outside : root;
    await fs.writeFile(path.join(root, 'a.txt'), 'A'); await fs.writeFile(path.join(outside, 'b.txt'), 'B');
    const a = await copyRequest(get, 'project', 'a.txt', 'external'), b = await copyRequest(get, 'external', 'b.txt', 'project');
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => execute(get, index % 2 ? a : b)));
    assert.equal(results.length, 12); assert.equal(new Set(results.map(value => value.root_id + ':' + value.path)).size, 12);
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'A');
    assert.equal(await fs.readFile(path.join(outside, 'b.txt'), 'utf8'), 'B');
    assert.equal((await execute(get, await copyRequest(get, 'project', 'a.txt', 'alias'))).path, 'a copy.txt');
    let entered = false;
    await withFilesystemLocks([outside, root, root, outside], async () => { entered = true; });
    assert.equal(entered, true);
  }));
});

test('filesystem actions preserve bytes, mode, topology and boundaries', { timeout: 120_000 }, async t => {
  await t.test('mkdir, literal Unicode/metacharacters, streamed binary copies, extension naming and disk-only draft copy', () => fixture(async ({ root, action, info, get }) => {
    const folder = '한글 😀 $() `literal`';
    assert.equal((await action('mkdir', '', { name: folder })).path, folder);
    assert.equal((await fs.stat(path.join(root, folder))).mode & 0o777, 0o777 & ~process.umask());
    const bytes = Buffer.from([255, 254, 0x00, 0xd8, 0x00, 0xdc, 13, 0, 10, 0]);
    await fs.writeFile(path.join(root, folder, '原本.tar.gz'), bytes, { mode: 0o640 });
    const selected = await info(folder + '/原本.tar.gz');
    assert.equal(selected.kind, 'file'); assert.equal(selected.symlink, false);
    const copy = await action('duplicate', folder + '/原本.tar.gz');
    assert.equal(copy.path, folder + '/原本.tar copy.gz');
    assert.deepEqual(await fs.readFile(path.join(root, copy.path)), bytes);
    assert.equal((await fs.stat(path.join(root, copy.path))).mode & 0o777, 0o640);
    await fs.writeFile(path.join(root, 'draft.txt'), 'DISK\r\n');
    const editor = await readEditor(root, 'draft.txt');
    assert.equal(editor.text, 'DISK\n');
    const draft = 'UNSAVED';
    assert.notEqual(draft, editor.text);
    const draftCopy = await action('duplicate', 'draft.txt');
    assert.equal(await fs.readFile(path.join(root, draftCopy.path), 'utf8'), 'DISK\r\n');
    const large = await fs.open(path.join(root, 'large.bin'), 'wx');
    try { for (let index = 0; index < 48; index++) await large.write(Buffer.alloc(256 * 1024, index)); }
    finally { await large.close(); }
    const copied = await action('duplicate', 'large.bin');
    assert.equal((await fs.stat(path.join(root, copied.path))).size, 12 * 1024 * 1024);
    const source = await fs.open(path.join(root, 'large.bin')), target = await fs.open(path.join(root, copied.path));
    try {
      const a = Buffer.alloc(256 * 1024), b = Buffer.alloc(256 * 1024);
      for (let index = 0; index < 48; index++) {
        await source.read(a, 0, a.length, index * a.length); await target.read(b, 0, b.length, index * b.length);
        assert.deepEqual(a, b);
      }
    } finally { await source.close(); await target.close(); }
    assert.notEqual((await info('draft.txt')).version, (await info(draftCopy.path)).version);
  }));

  await t.test('recursive copies/deletion include hidden and excluded descendants, symlinks stay leaves', () => fixture(async ({ root, outside, action }) => {
    await fs.writeFile(path.join(outside, 'canary'), 'OUTSIDE');
    await fs.mkdir(path.join(root, 'tree', '.git'), { recursive: true });
    await fs.mkdir(path.join(root, 'tree', 'nested'));
    await fs.writeFile(path.join(root, 'tree', '.hidden'), 'hidden');
    await fs.writeFile(path.join(root, 'tree', '.git', 'literal'), 'metadata');
    await fs.writeFile(path.join(root, 'tree', 'nested', 'plain'), 'plain');
    for (const [name, target] of [['outside', outside], ['inside', 'nested'], ['broken', 'absent']])
      await fs.symlink(target, path.join(root, 'tree', name));
    const copy = await action('duplicate', 'tree');
    assert.equal(copy.path, 'tree copy');
    assert.equal(await fs.readFile(path.join(root, copy.path, '.hidden'), 'utf8'), 'hidden');
    assert.equal(await fs.readFile(path.join(root, copy.path, '.git', 'literal'), 'utf8'), 'metadata');
    for (const name of ['outside', 'inside', 'broken']) assert.equal(await fs.readlink(path.join(root, copy.path, name)), await fs.readlink(path.join(root, 'tree', name)));
    assert.equal((await action('delete', copy.path, { confirmed: true })).deleted, true);
    await assert.rejects(fs.lstat(path.join(root, copy.path)), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(outside, 'canary'), 'utf8'), 'OUTSIDE');
    assert.equal(await fs.readFile(path.join(root, 'tree', 'nested', 'plain'), 'utf8'), 'plain');
  }));

  await t.test('final links to internal, outside and broken destinations copy/rename/delete the link node', () => fixture(async ({ root, outside, action, info }) => {
    await fs.writeFile(path.join(outside, 'canary'), 'OUTSIDE');
    await fs.writeFile(path.join(root, 'plain'), 'INSIDE');
    for (const [index, target] of ['plain', path.join(outside, 'canary'), 'missing'].entries()) {
      const name = `link${index}.txt`; await fs.symlink(target, path.join(root, name));
      assert.equal((await info(name)).kind, 'symlink');
      const copy = await action('duplicate', name);
      assert.equal(await fs.readlink(path.join(root, copy.path)), target);
      const renamed = await action('rename', name, { name: `new${index}.txt` });
      assert.equal(await fs.readlink(path.join(root, renamed.path)), target);
      await action('delete', copy.path, { confirmed: true }); await action('delete', renamed.path, { confirmed: true });
    }
    const rawLink = Buffer.from([0xff, 0xfe, 0x2f, 0x61]);
    await fs.symlink(rawLink, path.join(root, 'raw-link'));
    const rawCopy = await action('duplicate', 'raw-link');
    assert.deepEqual(await fs.readlink(path.join(root, rawCopy.path), { encoding: 'buffer' }), rawLink);
    await action('delete', 'raw-link', { confirmed: true }); await action('delete', rawCopy.path, { confirmed: true });
    assert.equal(await fs.readFile(path.join(root, 'plain'), 'utf8'), 'INSIDE');
    assert.equal(await fs.readFile(path.join(outside, 'canary'), 'utf8'), 'OUTSIDE');
  }));

  await t.test('16 concurrent copies use distinct names; rename collisions never overwrite files, directories or links', () => fixture(async ({ root, action, info, get }) => {
    await fs.writeFile(path.join(root, 'data.txt'), 'ORIGINAL');
    const expected_version = (await info('data.txt')).version;
    const copies = await Promise.all(Array.from({ length: 16 }, () => filesystemAction(get, { action: 'duplicate', root: 'project', path: 'data.txt', expected_version })));
    assert.equal(new Set(copies.map(value => value.path)).size, 16);
    for (const copy of copies) assert.equal(await fs.readFile(path.join(root, copy.path), 'utf8'), 'ORIGINAL');
    await fs.writeFile(path.join(root, 'left'), 'LEFT'); await fs.writeFile(path.join(root, 'right'), 'RIGHT');
    const result = await Promise.allSettled(['left', 'right'].map(relative => action('rename', relative, { name: 'winner' })));
    assert.equal(result.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(result.find(value => value.status === 'rejected').reason.status, 409);
    const winner = await fs.readFile(path.join(root, 'winner'), 'utf8');
    assert.ok(['LEFT', 'RIGHT'].includes(winner));
    await fs.mkdir(path.join(root, 'directory')); await fs.symlink('missing', path.join(root, 'broken'));
    for (const name of ['winner', 'directory', 'broken']) await assert.rejects(action('rename', 'data.txt', { name }), { status: 409 });
    assert.equal(await fs.readFile(path.join(root, 'data.txt'), 'utf8'), 'ORIGINAL');
  }));

  await t.test('unsupported descendants are preflighted before any delete; direct hidden, root and linked parents are blocked', () => fixture(async ({ root, outside, action, get, info }) => {
    await fs.mkdir(path.join(root, 'tree'));
    await fs.writeFile(path.join(root, 'tree', 'first'), 'KEEP');
    await run('mkfifo', [path.join(root, 'tree', 'fifo')]);
    for (const type of ['duplicate', 'delete']) await assert.rejects(action(type, 'tree', { ...(type === 'delete' ? { confirmed: true } : {}) }), { status: 403 });
    assert.equal(await fs.readFile(path.join(root, 'tree', 'first'), 'utf8'), 'KEEP');
    assert.deepEqual((await fs.readdir(root)).sort(), ['tree']);
    await fs.symlink(outside, path.join(root, 'parent-link'));
    for (const parent of ['', '../outside', '/tmp', '.hidden', '.git', 'node_modules', 'parent-link']) {
      if (!parent) await assert.rejects(info(parent), { status: 403 });
      else await assert.rejects(action('mkdir', parent, { name: 'x' }), error => [400, 403].includes(error.status));
    }
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'nul\0', '\ud800']) await assert.rejects(action('mkdir', '', { name }), { status: 400 });
    assert.deepEqual(await fs.readdir(outside), []);
    await assert.rejects(filesystemAction(get, { action: 'delete', root: 'project', path: '', expected_version: 'a'.repeat(64), confirmed: true }), { status: 403 });
  }));

  await t.test('filesystem versions reject modified source, replaced inode and replaced root', () => fixture(async ({ root, base, info, get }) => {
    await fs.writeFile(path.join(root, 'source'), 'before');
    const original = await info('source');
    await fs.writeFile(path.join(root, 'source'), 'after');
    for (const action of ['duplicate', 'rename', 'delete']) await assert.rejects(filesystemAction(get, {
      action, root: 'project', path: 'source', expected_version: original.version, ...(action === 'rename' ? { name: 'next' } : {}),
      ...(action === 'delete' ? { confirmed: true } : {}),
    }), { status: 409 });
    const selected = await info('source');
    await fs.rename(root, path.join(base, 'old-root')); await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'source'), 'after');
    await assert.rejects(filesystemAction(get, { action: 'delete', root: 'project', path: 'source', expected_version: selected.version, confirmed: true }), { status: 409 });
    assert.equal(await fs.readFile(path.join(root, 'source'), 'utf8'), 'after');
  }));

  await t.test('parent/root swaps clean only exact owned duplicate; external replacements and written canaries survive', () => fixture(async ({ root, outside, base, action }) => {
    for (const kind of ['clean', 'written', 'replaced', 'hardlinked', 'unexpected']) {
      const parent = path.join(root, kind), moved = path.join(root, kind + '-moved');
      await fs.mkdir(parent); await fs.writeFile(path.join(parent, 'source'), 'SOURCE');
      let intercepted = false;
      await patch(fsPromises, 'open', original => async (target, flags, ...rest) => {
        const file = await original(target, flags, ...rest);
        if (!intercepted && String(target).startsWith('/proc/self/fd/') && typeof flags === 'number' && (flags & constants.O_CREAT)) {
          intercepted = true;
          await fs.rename(parent, moved); await fs.symlink(outside, parent);
          const created = path.join(moved, 'source copy');
          if (kind === 'written') await fs.writeFile(created, 'EXTERNAL CANARY');
          if (kind === 'replaced') { await fs.unlink(created); await fs.writeFile(created, 'REPLACEMENT'); }
          if (kind === 'hardlinked') await fs.link(created, path.join(moved, 'hardlink'));
        }
        return file;
      }, async () => await assert.rejects(action('duplicate', kind + '/source'), error => [403, 409].includes(error.status)));
      assert.equal(intercepted, true);
      assert.equal(await fs.readFile(path.join(moved, 'source'), 'utf8'), 'SOURCE');
      if (['clean', 'unexpected'].includes(kind)) await assert.rejects(fs.lstat(path.join(moved, 'source copy')), { code: 'ENOENT' });
      if (kind === 'written') assert.equal(await fs.readFile(path.join(moved, 'source copy'), 'utf8'), 'EXTERNAL CANARY');
      if (kind === 'replaced') assert.equal(await fs.readFile(path.join(moved, 'source copy'), 'utf8'), 'REPLACEMENT');
      if (kind === 'hardlinked') assert.equal((await fs.stat(path.join(moved, 'source copy'))).nlink, 2);
    }
    assert.deepEqual(await fs.readdir(outside), []);
  }));

  await t.test('mkdir parent swap and recursive duplicate unknown child preserve outside/foreign canaries', () => fixture(async ({ root, outside, action }) => {
    await fs.mkdir(path.join(root, 'parent'));
    let intercepted = false;
    await patch(fsNative, 'mkdirSync', original => (target, ...rest) => {
      const result = original(target, ...rest);
      if (!intercepted && String(target).startsWith('/proc/self/fd/')) {
        intercepted = true;
        fsNative.renameSync(path.join(root, 'parent'), path.join(root, 'moved'));
        fsNative.symlinkSync(outside, path.join(root, 'parent'));
      }
      return result;
    }, async () => await assert.rejects(action('mkdir', 'parent', { name: 'created' }), error => [403, 409].includes(error.status)));
    assert.deepEqual(await fs.readdir(path.join(root, 'moved')), []);
    assert.deepEqual(await fs.readdir(outside), []);
    await fs.mkdir(path.join(root, 'tree')); await fs.writeFile(path.join(root, 'tree', 'source'), 'SOURCE');
    intercepted = false;
    await patch(fsNative, 'mkdirSync', original => (target, ...rest) => {
      const result = original(target, ...rest);
      if (!intercepted && String(target).startsWith('/proc/self/fd/')) {
        intercepted = true;
        fsNative.writeFileSync(`${target}/foreign`, 'FOREIGN CANARY');
      }
      return result;
    }, async () => await assert.rejects(action('duplicate', 'tree'), { status: 409 }));
    assert.equal(await fs.readFile(path.join(root, 'tree copy', 'foreign'), 'utf8'), 'FOREIGN CANARY');
    assert.equal(await fs.readFile(path.join(root, 'tree', 'source'), 'utf8'), 'SOURCE');
  }));

  await t.test('rename file/folder editor bindings preserve draft-safe baseline, encoding and per-root tab preference', () => fixture(async ({ root, action, get }) => {
    await fs.mkdir(path.join(root, 'folder')); await fs.writeFile(path.join(root, 'folder', '文書.md'), Buffer.from('\ufeff한글\r\n', 'utf16le'));
    const old = await readEditor(root, 'folder/文書.md');
    await setEditorView(root, old.path, 'source');
    const renamed = await action('rename', 'folder', { name: 'renamed', editors: [{ path: old.path, version: old.version }] });
    assert.equal(renamed.editors.length, 1); const binding = renamed.editors[0];
    assert.equal(binding.old_path, old.path); assert.equal(binding.path, 'renamed/文書.md'); assert.equal(binding.old_version, old.version);
    assert.match(binding.version, /^[a-f0-9]{64}$/); assert.notEqual(binding.version, old.version);
    const reopened = await readEditor(root, binding.path); assert.equal(reopened.tab, 'source'); assert.equal(reopened.encoding, 'UTF-16LE');
    await saveEditor(get, binding.path, 'DRAFT 한글\n', binding.version);
    assert.deepEqual(await fs.readFile(path.join(root, binding.path)), Buffer.from('\ufeffDRAFT 한글\r\n', 'utf16le'));
    await assert.rejects(saveEditor(get, old.path, 'bad', old.version), { status: 409 });
  }));

  await t.test('stale affected editor rejects before rename; post-rename external edit returns null binding without blessing bytes', () => fixture(async ({ root, action, get, info }) => {
    await fs.mkdir(path.join(root, 'folder')); await fs.writeFile(path.join(root, 'folder', 'file.txt'), 'ORIGINAL');
    const old = await readEditor(root, 'folder/file.txt');
    await fs.writeFile(path.join(root, old.path), 'EXTERNAL');
    await assert.rejects(action('rename', 'folder', { name: 'rejected', editors: [{ path: old.path, version: old.version }] }), { status: 409 });
    assert.equal(await fs.readFile(path.join(root, old.path), 'utf8'), 'EXTERNAL');
    const fresh = await readEditor(root, old.path);
    await patch(fsNative, 'renameSync', original => (from, to) => {
      const result = original(from, to);
      if (String(from).startsWith('/proc/self/fd/')) fsNative.writeFileSync(`${to}/file.txt`, 'CHANGED AFTER RENAME');
      return result;
    }, async () => {
      const result = await action('rename', 'folder', { name: 'renamed', editors: [{ path: fresh.path, version: fresh.version }] });
      assert.equal(result.editors[0].version, null); assert.match(result.editors[0].reason, /keep your draft/);
      await assert.rejects(saveEditor(get, result.editors[0].path, 'UNSAVED', fresh.version), { status: 409 });
    });
    assert.equal(await fs.readFile(path.join(root, 'renamed/file.txt'), 'utf8'), 'CHANGED AFTER RENAME');
  }));
});

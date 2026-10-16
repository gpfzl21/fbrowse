"""Real tmux/HTTP integration checks; all sessions belong to temporary projects."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import time
import unittest
import urllib.error
import urllib.request


SCRIPT = Path(__file__).with_name('file-browser.sh').resolve()
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fbrowse-test-')
        self.base = Path(self.temp.name)
        self.roots = []
        self.env = dict(os.environ, XDG_STATE_HOME=str(self.base / 'state'),
                        XDG_DATA_HOME=str(self.base / 'data'), XDG_CONFIG_HOME=str(self.base / 'config'),
                        HOME=str(self.base / 'home'), FBROWSE_NO_OPEN='1')
        Path(self.env['HOME']).mkdir()

    def tearDown(self):
        for root in self.roots:
            self.run_launcher('stop', root, check=False)
        self.temp.cleanup()

    def project(self, name):
        root = self.base / name
        root.mkdir()
        self.roots.append(root)
        return root

    def run_launcher(self, *args, check=True, script=SCRIPT, cwd=None):
        result = subprocess.run(['bash', str(script), *map(str, args)], env=self.env,
                                text=True, capture_output=True, timeout=15, cwd=cwd)
        if check:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def metadata(self, root):
        key = hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:16]
        path = self.base / 'state' / 'project-file-browser' / key / 'server.json'
        return path, json.loads(path.read_text())

    def info(self, url):
        with OPENER.open(url + 'api/info', timeout=2) as response:
            return json.load(response)

    def test_concurrent_start_reuse_alias_and_persistence(self):
        root = self.project('first')
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            results = list(executor.map(lambda _: self.run_launcher('start', root, '--no-pdfjs'), range(3)))
        urls = [re.search(r'http://127\.0\.0\.1:\d+/', result.stdout)[0] for result in results]
        self.assertEqual(len(set(urls)), 1)
        self.assertEqual(self.info(urls[0])['root'], str(root))
        alias = self.base / 'alias'
        alias.symlink_to(root, target_is_directory=True)
        self.assertEqual(self.run_launcher('url', alias).stdout.strip(), urls[0])
        _, metadata = self.metadata(root)
        self.assertEqual(metadata['instance_id'], self.info(urls[0])['instance_id'])
        self.assertIn('Open in Orca browser:', self.run_launcher('logs', root).stdout)

    def test_projects_have_distinct_ports_and_stop_is_scoped(self):
        first, second = self.project('one'), self.project('two')
        for root in (first, second):
            self.run_launcher('start', root, '--no-pdfjs')
        urls = [self.run_launcher('url', root).stdout.strip() for root in (first, second)]
        self.assertNotEqual(*urls)
        listing = self.run_launcher('list').stdout
        for url in urls:
            self.assertIn(url, listing)
        self.run_launcher('stop', first)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                self.info(urls[0])
            except (OSError, urllib.error.URLError):
                break
            time.sleep(.05)
        else:
            self.fail('Stopped server still accepts connections')
        self.assertEqual(self.info(urls[1])['root'], str(second))

    def test_paths_are_shell_quoted_and_output_remains_in_tmux(self):
        root = self.project("한글 ' space $(touch PWNED) `touch BAD` ;")
        self.run_launcher('start', root, '--no-pdfjs')
        url = self.run_launcher('url', root).stdout.strip()
        self.assertEqual(self.info(url)['root'], str(root))
        self.assertFalse((root / 'PWNED').exists())
        self.assertFalse((root / 'BAD').exists())
        key = hashlib.sha256(str(root).encode()).hexdigest()[:16]
        session = subprocess.check_output(['tmux', 'list-sessions', '-F', '#{session_name}'], text=True)
        session = next(line for line in session.splitlines() if line.endswith(key))
        screen = subprocess.check_output(['tmux', 'capture-pane', '-p', '-t', session], text=True)
        self.assertIn('Open in Orca browser:', screen)

    def test_identity_mismatch_requires_explicit_restart(self):
        root = self.project('identity')
        self.run_launcher('start', root, '--no-pdfjs')
        path, data = self.metadata(root)
        original = data['instance_id']
        data['instance_id'] = 'wrong-server'
        path.write_text(json.dumps(data))
        result = self.run_launcher('start', root, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('restart', result.stderr)
        self.run_launcher('restart', root, '--no-pdfjs')
        self.assertNotEqual(self.metadata(root)[1]['instance_id'], original)

    def test_install_and_run_outside_script_directory(self):
        root = self.project('installed')
        self.run_launcher('install')
        installed = self.base / 'home' / '.local' / 'bin' / 'fbrowse'
        self.assertTrue(installed.is_symlink())
        self.run_launcher('install')  # An update must be repeatable.
        self.run_launcher('start', root, '--no-pdfjs', script=installed)
        url = self.run_launcher('url', root, script=installed).stdout.strip()
        self.assertEqual(self.info(url)['root'], str(root))

    def test_install_update_uninstall_and_empty_current_directories(self):
        first, second = self.project('empty one'), self.project('empty two')
        self.run_launcher('install')
        installed = Path(self.env['HOME']) / '.local/bin/fbrowse'
        self.assertEqual(self.run_launcher('--version', script=installed).stdout.strip(), '0.1.0')
        for root in (first, second):
            self.run_launcher('--no-pdfjs', script=installed, cwd=root)
        urls = [self.run_launcher('url', script=installed, cwd=root).stdout.strip() for root in (first, second)]
        self.run_launcher('update', SCRIPT.parent, script=installed)
        self.assertEqual(self.info(urls[0])['root'], str(first))
        self.run_launcher('restart', '--no-pdfjs', script=installed, cwd=first)
        self.assertEqual(self.run_launcher('url', script=installed, cwd=first).stdout.strip(), urls[0])
        self.run_launcher('uninstall', script=installed)
        self.assertFalse(installed.exists())
        for root, url in zip((first, second), urls):
            self.assertEqual(list(root.iterdir()), [])
            self.assertEqual(self.info(url)['root'], str(root))
        installed.write_text('unrelated command')
        for action in ('install', 'uninstall'):
            self.assertNotEqual(self.run_launcher(action, check=False).returncode, 0)
            self.assertEqual(installed.read_text(), 'unrelated command')

    def test_roots_cli_remembers_project_mapping_and_live_changes(self):
        project, other, papers = [self.project(name) for name in ('project', 'other', 'papers')]
        self.run_launcher('roots', 'add', 'papers', papers, '--name', '논문', cwd=project)
        self.assertIn('논문', self.run_launcher('roots', cwd=project).stdout)
        self.assertNotIn('논문', self.run_launcher('roots', cwd=other).stdout)
        self.assertEqual(list(project.iterdir()), [])
        self.run_launcher('start', project, '--no-pdfjs')
        url = self.run_launcher('url', project).stdout.strip()
        self.assertEqual(self.info(url)['roots'][1]['name'], '논문')
        self.run_launcher('roots', 'edit', 'papers', other, '--name', '자료', '--project', project)
        self.assertEqual(self.info(url)['roots'][1]['path'], str(other))
        self.run_launcher('roots', 'remove', 'papers', '--project', project)
        self.assertEqual(len(self.info(url)['roots']), 1)

    def test_release_archive_can_install_and_run(self):
        output = self.base / 'release'
        subprocess.run(['python3', '-B', str(SCRIPT.with_name('build_release.py')), '--output', str(output)],
                       check=True, capture_output=True, env=self.env)
        archive = output / 'fbrowse-0.1.0.tar.gz'
        self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(),
                         archive.with_name(archive.name + '.sha256').read_text().split()[0])
        with tarfile.open(archive) as bundle:
            self.assertFalse(any('/.git/' in name or '/.aws/' in name for name in bundle.getnames()))
            # Archive was created from the builder's explicit source allowlist.
            bundle.extractall(output)
        release_script = output / 'fbrowse-0.1.0/file-browser.sh'
        self.run_launcher('install', script=release_script)
        installed = Path(self.env['HOME']) / '.local/bin/fbrowse'
        root = self.project('from archive')
        self.run_launcher('--no-pdfjs', script=installed, cwd=root)
        url = self.run_launcher('url', script=installed, cwd=root).stdout.strip()
        self.assertEqual(self.info(url)['version'], '0.1.0')
        self.assertEqual(list(root.iterdir()), [])

    def fake_orca(self):
        fake = self.base / 'fake orca'
        state = self.base / 'orca-tabs.json'
        state.write_text(json.dumps({'tabs': [], 'calls': []}))
        fake.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
path = Path(os.environ['FBROWSE_FAKE_ORCA_STATE'])
data = json.loads(path.read_text())
args = sys.argv[1:]
data['calls'].append(args)
def option(flag): return args[args.index(flag)+1]
if data.get('fail'):
    path.write_text(json.dumps(data))
    print(json.dumps({'ok': False, 'error': {'code': 'browser_host_unavailable'}}))
    sys.exit(1)
if args[:2] == ['worktree', 'current']:
    result = {'worktree': {'id': 'discovered::' + os.environ['FBROWSE_FAKE_WORKTREE_PATH'],
                          'path': os.environ['FBROWSE_FAKE_WORKTREE_PATH']}}
elif args[:2] == ['tab', 'list']:
    result = {'tabs': data['tabs']}
elif args[:2] == ['tab', 'create']:
    tab = {'browserPageId': 'page-' + str(len(data['tabs'])), 'url': option('--url')}
    data['tabs'].append(tab)
    result = {'browserPageId': tab['browserPageId']}
elif args[0] == 'goto':
    next(tab for tab in data['tabs'] if tab['browserPageId'] == option('--page'))['url'] = option('--url')
    result = {}
elif args[:2] == ['tab', 'switch']:
    data['active'] = option('--page')
    result = {}
else: raise RuntimeError(args)
path.write_text(json.dumps(data))
print(json.dumps({'ok': True, 'result': result}))
''')
        fake.chmod(0o755)
        self.env.update(ORCA_CLI_COMMAND=str(fake), FBROWSE_FAKE_ORCA_STATE=str(state),
                        FBROWSE_NO_OPEN='0', ORCA_WORKTREE_ID='test-id::' + str(self.base))
        return state

    def test_auto_open_discovers_current_workspace_without_orca_environment(self):
        state = self.fake_orca()
        (self.base / 'orca-ide').symlink_to(self.env['ORCA_CLI_COMMAND'])
        for name in ('ORCA_CLI_COMMAND', 'ORCA_WORKTREE_ID', 'ORCA_TERMINAL_HANDLE', 'ORCA_DEV_REPO_ROOT'):
            self.env.pop(name, None)
        self.env['PATH'] = str(self.base) + os.pathsep + self.env['PATH']
        self.env['FBROWSE_FAKE_WORKTREE_PATH'] = str(self.base)
        root = self.project('discovered project')
        self.assertIn('Orca Browser: fbrowse', self.run_launcher('--no-pdfjs', cwd=root).stdout)
        data = json.loads(state.read_text())
        self.assertEqual(len(data['tabs']), 1)
        self.assertEqual(data['calls'][0][:2], ['worktree', 'current'])
        # An unrelated active workspace must not receive a tab just because Orca is installed.
        self.env['FBROWSE_FAKE_WORKTREE_PATH'] = str(self.base / 'elsewhere')
        previous = data['tabs']
        self.assertIn('http://', self.run_launcher(cwd=root).stdout)
        self.assertEqual(json.loads(state.read_text())['tabs'], previous)

    def test_auto_open_reuses_tab_without_reloading_selected_file(self):
        state = self.fake_orca()
        root = self.project('auto open')
        output = self.run_launcher(root, '--no-pdfjs').stdout
        self.assertIn('Orca Browser: fbrowse', output)
        self.assertNotIn('http://', output)
        data = json.loads(state.read_text())
        selected_url = data['tabs'][0]['url'] + '?root=project&path=sample.py'
        data['tabs'][0]['url'] = selected_url
        state.write_text(json.dumps(data))
        self.run_launcher(root)
        data = json.loads(state.read_text())
        self.assertEqual(len(data['tabs']), 1)
        self.assertEqual(data['tabs'][0]['url'], selected_url)
        self.assertFalse(any(call[0] == 'goto' for call in data['calls']))
        self.assertEqual(data['active'], 'page-0')
        self.assertTrue(all(call[call.index('--worktree')+1] == 'id:' + self.env['ORCA_WORKTREE_ID'] for call in data['calls']))
        previous_calls = data['calls']
        self.assertIn('http://', self.run_launcher(root, '--no-open').stdout)
        self.run_launcher('url', root)
        self.assertEqual(json.loads(state.read_text())['calls'], previous_calls)
        self.run_launcher('stop', root)
        self.run_launcher(root, '--no-pdfjs')
        data = json.loads(state.read_text())
        self.assertEqual(len(data['tabs']), 1)
        self.assertTrue(data['tabs'][0]['url'].endswith('?root=project&path=sample.py'))

    def test_open_preserves_foreign_tabs_and_falls_back_to_url(self):
        state = self.fake_orca()
        root = self.project('open isolation')
        self.run_launcher(root, '--no-pdfjs')
        data = json.loads(state.read_text())
        data['tabs'][0]['url'] = 'https://example.com/'
        state.write_text(json.dumps(data))
        self.run_launcher('open', root)
        data = json.loads(state.read_text())
        self.assertEqual(len(data['tabs']), 2)
        self.assertEqual(data['tabs'][0]['url'], 'https://example.com/')
        data['fail'] = True
        state.write_text(json.dumps(data))
        result = self.run_launcher(root)
        self.assertIn('http://127.0.0.1:', result.stdout)
        self.assertIn('browser_host_unavailable', result.stderr)
        self.assertEqual(self.info(self.run_launcher('url', root).stdout.strip())['root'], str(root))

    def test_never_stops_an_unowned_tmux_session(self):
        root = self.project('unrelated')
        key = hashlib.sha256(str(root).encode()).hexdigest()[:16]
        session = 'files-unrelated-' + key
        subprocess.run(['tmux', 'new-session', '-d', '-s', session, 'sleep', '30'], check=True)
        try:
            result = self.run_launcher('stop', root, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('다른 tmux 세션', result.stderr)
            subprocess.run(['tmux', 'has-session', '-t', session], check=True)
        finally:
            subprocess.run(['tmux', 'kill-session', '-t', session], check=True)


if __name__ == '__main__':
    unittest.main()

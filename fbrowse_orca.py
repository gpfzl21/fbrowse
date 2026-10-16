"""Open/focus fbrowse in Orca; optional integration, no browser runtime dependency."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
from urllib.parse import urlsplit, urlunsplit


def origin(url):
    parsed = urlsplit(url)
    return parsed.scheme, parsed.netloc


def cli_command():
    configured = os.environ.get('ORCA_CLI_COMMAND')
    if configured:
        return [configured] if Path(configured).is_file() else shlex.split(configured)
    name = 'orca-dev' if os.environ.get('ORCA_DEV_REPO_ROOT') else 'orca-ide'
    executable = shutil.which(name)
    if not executable:
        raise ValueError('Orca CLI를 찾을 수 없습니다.')
    return [executable]


def open_browser(url, state_dir, mode='auto'):
    command = cli_command()
    worktree = os.environ.get('ORCA_WORKTREE_ID')
    scope = ['--worktree', 'id:' + worktree] if worktree else []

    def call(*arguments):
        result = subprocess.run([*command, *arguments, *scope, '--json'],
                                text=True, capture_output=True, timeout=25)
        try:
            data = json.loads(result.stdout)
        except ValueError:
            raise ValueError('Orca CLI 응답을 확인할 수 없습니다.') from None
        if not isinstance(data, dict):
            raise ValueError('Orca CLI 응답 형식이 올바르지 않습니다.')
        if result.returncode or not data.get('ok'):
            error = data.get('error', {})
            message = (error.get('message') or error.get('code')) if isinstance(error, dict) else str(error)
            raise ValueError(message or 'Orca Browser에 연결할 수 없습니다.')
        payload = data.get('result', {})
        if not isinstance(payload, dict):
            raise ValueError('Orca CLI 결과 형식이 올바르지 않습니다.')
        return payload

    if not worktree:
        try:
            current = call('worktree', 'current')['worktree']
            if not Path.cwd().resolve().is_relative_to(Path(current['path']).resolve()):
                raise ValueError('현재 폴더의 Orca workspace를 확인할 수 없습니다.')
            worktree = current['id']
            scope = ['--worktree', 'id:' + worktree]
        except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
            if mode == 'auto':
                return False
            raise ValueError('현재 폴더의 Orca workspace를 확인할 수 없습니다. Orca 터미널에서 실행하세요.') from None

    state_dir.mkdir(parents=True, exist_ok=True)
    with (state_dir / 'browser.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        record_path = state_dir / 'browser.json'
        try:
            record = json.loads(record_path.read_text())
            if not isinstance(record, dict):
                record = {}
        except (OSError, ValueError):
            record = {}
        tabs = call('tab', 'list').get('tabs', [])
        candidate = next((tab for tab in tabs if tab.get('browserPageId') == record.get('page')
                          and record.get('worktree') == worktree
                          and origin(tab.get('url', '')) == origin(record.get('url', ''))
                          and urlsplit(tab.get('url', '')).path in ('', '/')), None)
        if candidate is None:
            candidate = next((tab for tab in tabs if origin(tab.get('url', '')) == origin(url)
                              and urlsplit(tab.get('url', '')).path in ('', '/')), None)
        reused = candidate is not None
        if candidate:
            page = candidate['browserPageId']
            if origin(candidate['url']) != origin(url):
                # A stopped/restarted server may have a new port. Keep its document selection.
                old, target = urlsplit(candidate['url']), urlsplit(url)
                call('goto', '--page', page, '--url', urlunsplit((target.scheme, target.netloc, '/', old.query, old.fragment)))
            elif ((candidate.get('title') or '') == 'Project Files'
                  or (candidate.get('title') or '').endswith(' · Project Files')) and not (
                      record.get('page') == page and record.get('named')):
                # Orca keeps tab metadata on reload; typed navigation updates legacy titles.
                # Migrate once, retaining the root/file query; later launches only focus.
                call('goto', '--page', page, '--url', candidate['url'])
            call('tab', 'switch', '--page', page, '--focus')
        else:
            created = call('tab', 'create', '--url', url)
            page = created.get('browserPageId')
            if not page:
                tabs = call('tab', 'list').get('tabs', [])
                candidate = next((tab for tab in tabs if origin(tab.get('url', '')) == origin(url)
                                  and urlsplit(tab.get('url', '')).path in ('', '/')), None)
                if candidate is None:
                    raise ValueError('브라우저 열기 요청 후 탭을 확인할 수 없습니다.')
                page = candidate['browserPageId']
            call('tab', 'switch', '--page', page, '--focus')
        temporary = record_path.with_suffix('.tmp')
        try:
            temporary.write_text(json.dumps({'page': page, 'url': url, 'worktree': worktree, 'named': True}))
            temporary.replace(record_path)
        finally:
            temporary.unlink(missing_ok=True)
    print('Orca Browser: fbrowse' + (' · 기존 탭으로 전환했습니다.' if reused else ' · 열었습니다.'))
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--state-dir', required=True, type=Path)
    parser.add_argument('--mode', choices=('auto', 'yes'), default='auto')
    args = parser.parse_args()
    if args.mode == 'auto' and os.environ.get('FBROWSE_NO_OPEN') == '1':
        return 2
    try:
        if not open_browser(args.url, args.state_dir, args.mode):
            return 2
    except (OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired) as error:
        if args.mode == 'auto' and not any(os.environ.get(name) for name in (
                'ORCA_WORKTREE_ID', 'ORCA_TERMINAL_HANDLE', 'ORCA_CLI_COMMAND')):
            return 2
        print(f'fbrowse: 브라우저를 자동으로 열지 못했습니다: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

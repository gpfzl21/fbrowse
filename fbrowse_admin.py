"""Local installation and selected-root CLI; Python standard library only."""
import argparse
import fcntl
import hashlib
import os
from pathlib import Path
import shutil
import sys
import tempfile

from fbrowse_storage import VERSION, project_config, read_config, change_root

FILES = ('file-browser.sh', 'file_browser.py', 'fbrowse_storage.py', 'fbrowse_admin.py',
         'README.md', 'FILE_BROWSER.md', 'LICENSE.md', 'THIRD_PARTY.md', 'VERSION')


def install(source):
    source = source.resolve(strict=True)
    for name in FILES:
        if not (source / name).is_file():
            raise ValueError(f'Incomplete app source: {name}')
    base = Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local/share'))) / 'project-file-browser'
    command = Path.home() / '.local/bin/fbrowse'
    launcher = base / 'file-browser.sh'
    if command.exists() or command.is_symlink():
        if not command.is_symlink() or os.readlink(command) != str(launcher):
            raise ValueError(f'Existing unrelated command left intact: {command}')
    if base.exists() and not (base / '.fbrowse-install').is_file():
        # Migrate only the original three-file installer, preserving its files.
        legacy = {'file-browser.sh', 'file_browser.py', 'FILE_BROWSER.md'}
        if not {p.name for p in base.iterdir()} <= legacy or not (base / 'file_browser.py').is_file():
            raise ValueError(f'Unrecognized installation directory left intact: {base}')
    base.mkdir(parents=True, exist_ok=True)
    with (base / '.install.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        (base / '.fbrowse-install').touch()
        digest = hashlib.sha256()
        for name in FILES:
            digest.update(name.encode() + b'\0' + (source / name).read_bytes())
        version = (source / 'VERSION').read_text().strip()
        if not version or any(c not in '0123456789abcdefghijklmnopqrstuvwxyz.-' for c in version):
            raise ValueError('Invalid VERSION')
        releases = base / 'releases'
        releases.mkdir(exist_ok=True)
        release = releases / (version + '-' + digest.hexdigest()[:16])
        with tempfile.TemporaryDirectory(prefix='.stage-', dir=releases) as temporary:
            stage = Path(temporary) / 'app'
            stage.mkdir()
            for name in FILES:
                shutil.copyfile(source / name, stage / name)
                (stage / name).chmod(0o755 if name == 'file-browser.sh' else 0o644)
            if not release.exists():
                stage.rename(release)
        def link(target, destination):
            temporary = destination.with_name(destination.name + f'.{os.getpid()}.tmp')
            try:
                temporary.symlink_to(target)
                temporary.replace(destination)
            finally:
                temporary.unlink(missing_ok=True)
        # Save the old files before the first atomic replacement.
        if launcher.is_file() and not launcher.is_symlink():
            legacy_dir = base / 'legacy-backup'
            legacy_dir.mkdir(exist_ok=True)
            for name in ('file-browser.sh', 'file_browser.py', 'FILE_BROWSER.md'):
                if (base / name).is_file():
                    shutil.copy2(base / name, legacy_dir / name)
        link(release, base / 'current')
        link('current/file-browser.sh', launcher)
        command.parent.mkdir(parents=True, exist_ok=True)
        link(launcher, command)
    print(f'설치 완료: {command} ({version})\n프로젝트 폴더에서 fbrowse 를 실행하세요.')
    print('업데이트는 실행 중인 서버를 유지합니다. 적용할 프로젝트에서 fbrowse restart 를 실행하세요.')
    if str(command.parent) not in os.environ.get('PATH', '').split(os.pathsep):
        print('PATH 설정: export PATH="$HOME/.local/bin:$PATH"')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for command in ('install', 'update'):
        sub = commands.add_parser(command)
        sub.add_argument('source', type=Path, nargs='?' if command == 'install' else None,
                         default=Path(__file__).parent)
    commands.add_parser('uninstall')
    commands.add_parser('version')
    roots = commands.add_parser('roots')
    roots.add_argument('--project', type=Path, default=Path.cwd())
    roots.add_argument('operation', choices=('list', 'add', 'edit', 'remove'), default='list', nargs='?')
    roots.add_argument('name', nargs='?')
    roots.add_argument('path', type=Path, nargs='?')
    roots.add_argument('--name', dest='label')
    args = parser.parse_args()
    if args.command == 'version':
        print(VERSION)
    elif args.command in ('install', 'update'):
        install(args.source)
    elif args.command == 'uninstall':
        base = Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local/share'))) / 'project-file-browser'
        command = Path.home() / '.local/bin/fbrowse'
        if command.is_symlink() and os.readlink(command) == str(base / 'file-browser.sh'):
            command.unlink()
        elif command.exists() or command.is_symlink():
            raise ValueError('Unrelated command left intact')
        print('fbrowse 명령 연결을 제거했습니다. 실행 중인 서버, 설치 버전, 설정과 캐시는 보존됩니다.')
    else:
        project = args.project.resolve(strict=True)
        if not project.is_dir():
            raise ValueError('Project must be a directory')
        if args.operation == 'list':
            if args.name or args.path:
                parser.error('roots list takes no name/path')
            print(f'project\t{project}')
            for root_id, record in read_config(project).items():
                print(f"{root_id}\t{record['name']}\t{record['path']}" +
                      ('' if Path(record['path']).is_dir() else '\t[연결 안 됨]'))
        else:
            if args.operation != 'remove' and args.path is None:
                parser.error('roots add/edit requires ID PATH [--name NAME]')
            if args.operation == 'remove' and args.path is not None:
                parser.error('roots remove takes only ID')
            change_root(project, args.operation, args.name, args.label or args.name,
                        str(args.path.resolve()) if args.path else None)
            print(f'설정 저장: {project_config(project)}\n브라우저에서 새로고침하세요.')



if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except (OSError, ValueError, KeyError) as error:
        sys.exit(f'fbrowse: {error}')

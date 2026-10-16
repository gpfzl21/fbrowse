"""Selected local roots. Configuration lives outside the project; no cloud access."""
import hashlib
import fcntl
import json
import os
from pathlib import Path
import re
import tempfile
import uuid

VERSION = '0.1.0'


def project_config(project):
    key = hashlib.sha256(str(Path(project).resolve()).encode()).hexdigest()[:16]
    base = Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config')))
    return base / 'fbrowse' / 'projects' / (key + '.json')


def read_config(project):
    try:
        data = json.loads(project_config(project).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {}
    if data.get('project') != str(Path(project).resolve()) or data.get('version') != 1:
        raise ValueError('Invalid project root configuration')
    roots = data['roots']
    if not isinstance(roots, dict):
        raise ValueError('Invalid roots')
    for root_id, record in roots.items():
        validate_name(root_id)
        if not isinstance(record, dict) or not isinstance(record.get('name'), str) or not record['name'].strip():
            raise ValueError('Invalid root name')
        path = record.get('path')
        if not isinstance(path, str) or not Path(path).is_absolute():
            raise ValueError('Root paths must be absolute')
    return roots


def validate_name(name):
    if name == 'project' or not re.fullmatch(r'[A-Za-z0-9_-]{1,48}', name):
        raise ValueError('Root ID: 1–48 ASCII letters/digits/_/-, excluding project')


def write_config(project, roots):
    target = project_config(project)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    data = {'version': 1, 'project': str(Path(project).resolve()), 'roots': roots}
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=target.parent,
                                     delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(data, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    try:
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def change_root(project, operation, root_id=None, name=None, path=None):
    """Serialize UI and CLI edits; only configuration is written."""
    target = project_config(project)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with target.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        selected = read_config(project)
        if operation == 'add':
            root_id = root_id or uuid.uuid4().hex[:16]
            validate_name(root_id)
            if root_id in selected:
                raise ValueError('Root ID already exists')
        elif operation in ('edit', 'remove'):
            validate_name(root_id or '')
            if root_id not in selected:
                raise ValueError('Unknown root ID')
        else:
            raise ValueError('Unknown root operation')
        if operation == 'remove':
            del selected[root_id]
        else:
            if not isinstance(name, str) or not name.strip() or len(name) > 120:
                raise ValueError('Root name is required (max 120 characters)')
            if not isinstance(path, str) or not Path(path).is_absolute():
                raise ValueError('서버의 절대 디렉터리 경로를 입력하세요.')
            directory = Path(path).resolve()
            # An unavailable existing root can still be renamed.
            unchanged = operation == 'edit' and str(directory) == selected[root_id]['path']
            if not unchanged and not directory.is_dir():
                raise ValueError('서버에 존재하는 디렉터리만 연결할 수 있습니다.')
            selected[root_id] = {'name': name.strip(), 'path': str(directory)}
        write_config(project, selected)
    return root_id

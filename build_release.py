"""Build an allowlisted, standalone source archive without project/private files."""
import argparse
import hashlib
from pathlib import Path
import tarfile

from fbrowse_admin import FILES
from fbrowse_storage import VERSION


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path(__file__).parent / 'dist')
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    names = (*FILES, '.gitignore', 'build_release.py', 'test_file_browser.py',
             'test_file_browser_launcher.py', 'test_browser.cjs', 'test_browser_fixture.py')
    args.output.mkdir(parents=True, exist_ok=True)
    archive = args.output / f'fbrowse-{VERSION}.tar.gz'
    with tarfile.open(archive, 'w:gz') as bundle:
        for name in names:
            path = source / name
            if not path.is_file() or path.is_symlink():
                raise ValueError(f'Invalid release source: {name}')
            info = bundle.gettarinfo(str(path), arcname=f'fbrowse-{VERSION}/{name}')
            info.uid = info.gid = info.mtime = 0
            info.uname = info.gname = ''
            with path.open('rb') as stream:
                bundle.addfile(info, stream)
    checksum = archive.with_name(archive.name + '.sha256')
    checksum.write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + '  ' + archive.name + '\n')
    print(archive)
    print(checksum)


if __name__ == '__main__':
    main()

"""Temporary data only, used by test_browser.cjs; not an application dependency."""
import json
import os
from pathlib import Path
import tempfile

from file_browser import FileBrowserHandler, FileBrowserServer, PDFJS_VERSION


def pdf_bytes():
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
               b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
               b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
               b'<< /Length 0 >>\nstream\n\nendstream']
    data, offsets = b'%PDF-1.4\n', [0]
    for number, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data += f'{number} 0 obj\n'.encode() + obj + b'\nendobj\n'
    start = len(data)
    data += b'xref\n0 5\n0000000000 65535 f \n'
    data += b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets[1:])
    return data + f'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n'.encode()


if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='fbrowse-browser-') as temporary:
        base = Path(temporary)
        os.environ['XDG_CONFIG_HOME'] = str(base / 'config')
        roots = [base / name for name in ('project', 'papers', 'results')]
        lines = ['message = "' + ('abcdefghij ' * 50) + '"', 'def after_long():',
                 '\treturn "' + ('한글 탭 문자열 ' * 40) + '"', '', 'class AfterUnicode:',
                 '\tpass', '', 'triple = """' + ('long string ' * 40),
                 '여러 줄 문자열 ' * 40, '"""', 'def after_multiline():', '    return 1', '']
        for root in roots:
            root.mkdir()
            (root / 'same.txt').write_text(root.name)
            (root / 'sample.py').write_text('\n'.join(lines), encoding='utf-8')
            (root / 'README.md').write_text('# 제목\n\n[동일 파일](same.txt)\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>window.PWNED=1</script>\n')
            (root / 'page.html').write_text('<link rel="stylesheet" href="style.css"><h1>fixture</h1>'
                                           '<script>parent.DOCUMENT_SCRIPT_RAN=true</script>')
            (root / 'style.css').write_text('h1 {color: rgb(1, 2, 3)}')
            (root / 'sample.pdf').write_bytes(pdf_bytes())
        (roots[1] / '하위 폴더').mkdir()
        (roots[1] / '하위 폴더' / 'marker.txt').write_text('inside folder')
        (roots[1] / '.hidden-folder').mkdir()
        cache = Path(os.environ.get('XDG_CACHE_HOME', str(Path.home() / '.cache')))
        pdfjs = cache / 'project-file-browser' / ('pdfjs-' + PDFJS_VERSION)
        FileBrowserHandler.log_message = lambda *args: None
        server = FileBrowserServer(('127.0.0.1', 0), roots[0],
                                   pdfjs_root=pdfjs if (pdfjs / 'web/viewer.html').is_file() else None)
        print(json.dumps({'url': f'http://127.0.0.1:{server.server_port}/',
                          'project': str(roots[0]), 'papers': str(roots[1]), 'results': str(roots[2]),
                          'pdfjs': server.pdfjs_root is not None}), flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()

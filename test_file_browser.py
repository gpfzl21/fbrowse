"""Integration checks: python3 -m unittest -v test_file_browser.py"""

import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import quote

from file_browser import FileBrowserHandler, FileBrowserServer
from fbrowse_storage import project_config, read_config


class FileBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name) / 'project'
        cls.root.mkdir()
        (cls.root / 'docs').mkdir()
        (cls.root / 'docs' / 'nested').mkdir()
        cls.pdf = b'%PDF-1.7\n' + bytes(range(256)) * 16000
        (cls.root / 'docs' / '큰 논문 #1%.pdf').write_bytes(cls.pdf)
        (cls.root / 'docs' / 'nested' / 'report.html').write_text(
            '<link rel="stylesheet" href="style.css"><h1>report</h1>')
        (cls.root / 'docs' / 'nested' / 'style.css').write_text('h1 { color: blue; }')
        (cls.root / 'empty.txt').touch()
        (cls.root / 'docs' / 'sample.py').write_text('# 한글\ndef hello():\n    return "<script>literal</script>"\n', encoding='utf-8')
        (cls.root / 'docs' / 'readme.md').write_text('# 제목\n\n**굵게**\n\n```python\nprint(42)\n```\n', encoding='utf-8')
        (cls.root / 'utf16.txt').write_text('한글 UTF-16\r\n둘째 줄', encoding='utf-16')
        (cls.root / 'binary.bin').write_bytes(b'\x00\xff\x80binary')
        (cls.root / 'large.py').write_text('# 큰 코드\n' + 'print("hello")\n' * 240000, encoding='utf-8')
        (cls.root / '.git').mkdir()
        (cls.root / '.git' / 'secret').write_text('git secret')
        (cls.root / '.env').write_text('secret')
        cls.outside = Path(cls.temp.name) / 'outside.txt'
        cls.outside.write_text('outside secret')
        (cls.root / 'outside-link.txt').symlink_to(cls.outside)
        (cls.root / 'git-link').symlink_to(cls.root / '.git', target_is_directory=True)
        cls.viewer = Path(cls.temp.name) / 'pdfjs'
        (cls.viewer / 'web').mkdir(parents=True)
        (cls.viewer / 'web' / 'viewer.html').write_text('<h1>PDF viewer asset</h1>')
        cls.old_log = FileBrowserHandler.log_message
        FileBrowserHandler.log_message = lambda *args: None
        cls.server = FileBrowserServer(('127.0.0.1', 0), cls.root, pdfjs_root=cls.viewer)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        FileBrowserHandler.log_message = cls.old_log
        cls.temp.cleanup()

    def request(self, path, headers=None, method='GET'):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        connection.request(method, path, headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_search_recursive_unicode_and_type_filter(self):
        status, _, body = self.request('/api/search?q='+quote('docs 논문')+'&type=pdf')
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertEqual(data['total'], 1)
        self.assertEqual(data['entries'][0]['path'], 'docs/큰 논문 #1%.pdf')
        _, _, body = self.request('/api/search?q=docs&type=html')
        self.assertEqual([e['name'] for e in json.loads(body)['entries']], ['report.html'])

    def test_large_file_full_head_and_range(self):
        url = '/files/' + quote('docs/큰 논문 #1%.pdf')
        status, headers, body = self.request(url)
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'application/pdf')
        self.assertGreater(len(body), 3 * 1024 * 1024)
        self.assertEqual(body, self.pdf)
        status, headers, body = self.request(url, {'Range': 'bytes=100-199'})
        self.assertEqual(status, 206)
        self.assertEqual(headers['Content-Range'], f'bytes 100-199/{len(self.pdf)}')
        self.assertEqual(body, self.pdf[100:200])
        status, headers, body = self.request(url, method='HEAD')
        self.assertEqual(status, 200)
        self.assertEqual(int(headers['Content-Length']), len(self.pdf))
        self.assertEqual(body, b'')

    def test_suffix_and_invalid_ranges(self):
        url = '/files/' + quote('docs/큰 논문 #1%.pdf')
        status, _, body = self.request(url, {'Range': 'bytes=-17'})
        self.assertEqual(status, 206)
        self.assertEqual(body, self.pdf[-17:])
        for value in ['bytes=-0', 'bytes=10-5', 'bytes=999999999-', 'bytes=1-2,4-5', 'bytes=-']:
            with self.subTest(value=value):
                status, headers, _ = self.request(url, {'Range': value})
                self.assertEqual(status, 416)
                self.assertEqual(headers['Content-Range'], f'bytes */{len(self.pdf)}')
        self.assertEqual(self.request('/files/empty.txt')[2], b'')
        self.assertEqual(self.request('/files/empty.txt', {'Range': 'bytes=0-1'})[0], 416)

    def test_relative_html_assets_and_live_refresh(self):
        status, _, body = self.request('/files/docs/nested/report.html')
        self.assertEqual(status, 200)
        self.assertIn(b'href="style.css"', body)
        self.assertEqual(self.request('/files/docs/nested/style.css')[0], 200)
        created = self.root / 'new-report.pdf'
        try:
            created.write_bytes(b'%PDF-new')
            _, _, body = self.request('/api/search?q=new-report&refresh=1')
            self.assertEqual(json.loads(body)['total'], 1)
            created.write_bytes(b'%PDF-updated')
            self.assertEqual(self.request('/files/new-report.pdf')[2], b'%PDF-updated')
        finally:
            created.unlink()

    def test_project_boundary_and_hidden_paths(self):
        for path in ['/files/%2e%2e/outside.txt', '/files/outside-link.txt',
                     '/files/.git/secret', '/files/git-link/secret', '/files/.env',
                     '/api/list?path='+quote('../'), '/api/list?path=/tmp']:
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 403)
        _, _, body = self.request('/api/list')
        names = {e['name'] for e in json.loads(body)['entries']}
        self.assertFalse(names & {'.git', '.env', 'outside-link.txt', 'git-link'})
        self.assertIn('docs', names)

    def test_viewer_assets_and_project_info(self):
        _, _, body = self.request('/api/info')
        self.assertTrue(json.loads(body)['pdfjs'])
        status, _, body = self.request('/_pdfjs/web/viewer.html')
        self.assertEqual(status, 200)
        self.assertIn(b'PDF viewer asset', body)
        self.assertEqual(self.request('/_pdfjs/%2e%2e/outside.txt')[0], 403)

    def test_code_and_markdown_text_api(self):
        status, headers, body = self.request('/api/text?path=docs/sample.py')
        self.assertEqual(status, 200)
        self.assertIn('application/json', headers['Content-Type'])
        data = json.loads(body)
        self.assertEqual(data['language'], 'python')
        self.assertIn('<script>literal</script>', data['text'])
        self.assertFalse(data['markdown'])
        status, _, body = self.request('/api/text?path=docs/readme.md')
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)['markdown'])
        self.assertIn('# 제목', json.loads(body)['text'])
        self.assertEqual(self.request('/_preview?path=docs/sample.py')[0], 200)
        self.assertEqual(self.request('/_preview?path=../outside.txt')[0], 403)

    def test_text_encoding_binary_and_large_source(self):
        status, _, body = self.request('/api/text?path=utf16.txt')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['text'], '한글 UTF-16\n둘째 줄')
        self.assertEqual(self.request('/api/text?path=binary.bin')[0], 415)
        self.assertEqual(self.request('/api/text?path=outside-link.txt')[0], 403)
        status, _, body = self.request('/api/text?path=large.py')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['text'], (self.root / 'large.py').read_text())
        self.assertGreater(len(json.loads(body)['text'].encode()), 3 * 1024 * 1024)

    def test_code_markdown_categories_and_filters(self):
        _, _, body = self.request('/api/list?path=docs')
        categories = {entry['name']: entry['category'] for entry in json.loads(body)['entries']}
        self.assertEqual(categories['sample.py'], 'code')
        self.assertEqual(categories['readme.md'], 'markdown')
        _, _, body = self.request('/api/search?q=docs&type=markdown')
        self.assertEqual([entry['name'] for entry in json.loads(body)['entries']], ['readme.md'])
        _, _, body = self.request('/api/search?q=sample&type=code')
        self.assertEqual([entry['name'] for entry in json.loads(body)['entries']], ['sample.py'])
        self.assertEqual(self.request('/_text_assets/unknown.js')[0], 404)


class MultiRootTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fbrowse-roots-')
        self.base = Path(self.temp.name)
        self.environment = patch.dict('os.environ', XDG_CONFIG_HOME=str(self.base / 'config'))
        self.environment.start()
        self.logger = patch.object(FileBrowserHandler, 'log_message', lambda *args: None)
        self.logger.start()
        self.project, self.papers, self.results = [self.base / name for name in ('project', 'papers', 'results')]
        for root in (self.project, self.papers, self.results):
            root.mkdir()
            (root / 'same.txt').write_text(root.name, encoding='utf-8')
        (self.papers / 'cross-root.txt').symlink_to(self.results / 'same.txt')
        (self.papers / '.secret').write_text('secret')
        (self.papers / 'page.html').write_text('<img src="image.svg">')
        (self.papers / 'image.svg').write_text('<svg/>')
        self.server = FileBrowserServer(('127.0.0.1', 0), self.project)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.token = self.server.config_token

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.environment.stop()
        self.logger.stop()
        self.temp.cleanup()

    def request(self, path, data=None, token=True, headers=None, method=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        headers = dict(headers or {})
        if data is not None:
            headers['Content-Type'] = 'application/json'
            if token:
                headers['X-Fbrowse-Token'] = self.token
        connection.request(method or ('POST' if data is not None else 'GET'), path,
                           json.dumps(data) if data is not None else None, headers)
        response = connection.getresponse()
        result = response.status, response.read()
        connection.close()
        return result

    def connect(self, root_id, path, name):
        status, body = self.request('/api/roots', {'operation': 'add', 'id': root_id, 'name': name, 'path': str(path)})
        self.assertEqual(status, 200, body)

    def test_root_identity_files_search_assets_and_boundaries(self):
        self.connect('papers', self.papers, '논문')
        self.connect('results', self.results, '실험 결과')
        for root_id in ('project', 'papers', 'results'):
            self.assertEqual(self.request(f'/roots/{root_id}/files/same.txt'), (200, root_id.encode()))
            status, body = self.request(f'/api/text?root={root_id}&path=same.txt')
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)['text'], root_id)
        status, body = self.request('/api/search?q=same')
        self.assertEqual(status, 200)
        self.assertEqual({e['root_id'] for e in json.loads(body)['entries']}, {'project', 'papers', 'results'})
        self.assertEqual(json.loads(self.request('/api/search?q=same&root=papers')[1])['total'], 1)
        for path in ('/roots/papers/files/cross-root.txt', '/roots/papers/files/%2e%2e/results/same.txt',
                     '/roots/papers/files/.secret', '/roots/unknown/files/same.txt',
                     '/api/list?root=papers&path=../results', '/api/text?root=unknown&path=same.txt'):
            self.assertEqual(self.request(path)[0], 403, path)
        for path in ('page.html', 'image.svg'):
            self.assertEqual(self.request('/roots/papers/files/' + path)[0], 200)
        content = b'%PDF' + b'x' * (4 * 1024 * 1024)
        (self.papers / 'large.pdf').write_bytes(content)
        self.assertEqual(self.request('/roots/papers/files/large.pdf', headers={'Range': 'bytes=10-99'}), (206, content[10:100]))

    def test_config_update_disconnected_root_and_removal(self):
        self.connect('papers', self.papers, '논문')
        self.assertTrue(project_config(self.project).is_relative_to(self.base / 'config'))
        self.assertEqual(read_config(self.project)['papers']['name'], '논문')
        self.papers.rename(self.base / 'unavailable')
        info = json.loads(self.request('/api/info')[1])
        self.assertFalse(next(r for r in info['roots'] if r['id'] == 'papers')['connected'])
        self.assertEqual(self.request('/api/list?root=papers')[0], 404)
        self.assertEqual(self.request('/roots/project/files/same.txt')[0], 200)
        status, _ = self.request('/api/roots', {'operation': 'edit', 'id': 'papers', 'name': '오프라인 논문', 'path': str(self.papers)})
        self.assertEqual(status, 200)
        status, _ = self.request('/api/roots', {'operation': 'remove', 'id': 'papers'})
        self.assertEqual(status, 200)
        self.assertTrue((self.base / 'unavailable/same.txt').is_file())
        self.assertEqual(self.request('/roots/papers/files/same.txt')[0], 403)

    def test_config_mutations_require_token_and_validate_inputs(self):
        data = {'operation': 'add', 'name': '논문', 'path': str(self.papers)}
        self.assertEqual(self.request('/api/roots', data, token=False)[0], 403)
        for bad in ({**data, 'path': '../papers'}, {**data, 'path': str(self.base / 'missing')},
                    {**data, 'id': 'project'}, {**data, 'id': '../bad'}, {**data, 'name': ''}):
            self.assertEqual(self.request('/api/roots', bad)[0], 400)
        self.assertEqual(len(json.loads(self.request('/api/info')[1])['roots']), 1)

    def test_replaced_root_symlink_keeps_original_boundary(self):
        self.connect('papers', self.papers, '논문')
        self.papers.rename(self.base / 'original-papers')
        self.papers.symlink_to(self.results, target_is_directory=True)
        info = json.loads(self.request('/api/info')[1])
        self.assertFalse(next(root for root in info['roots'] if root['id'] == 'papers')['connected'])
        self.assertEqual(self.request('/roots/papers/files/same.txt')[0], 403)
        entries = json.loads(self.request('/api/search?q=same&refresh=1')[1])['entries']
        self.assertEqual([entry['root_id'] for entry in entries], ['project'])


if __name__ == '__main__':
    unittest.main()

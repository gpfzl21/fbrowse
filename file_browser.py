#!/usr/bin/env python3
"""Read-only, searchable project file browser. Requires Python 3.10+, no packages.

    python3 file_browser.py --root /path/to/project --port 8765

The first launch caches Mozilla's PDF.js viewer (~6 MB download). Later launches
work offline. Use --no-pdfjs to use the browser's native PDF viewer instead.
Open http://127.0.0.1:8765 in the Orca browser on the server. With orca serve,
this does not create a localhost listener on the connecting desktop computer.
"""

import argparse
import hashlib
import heapq
import json
import mimetypes
import os
from pathlib import Path
import re
import stat
import tempfile
import threading
import time
import urllib.request
import uuid
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlsplit

from fbrowse_storage import VERSION, read_config, change_root


EXCLUDED = {".git", ".venv", "venv", "node_modules", "__pycache__", ".cache"}
TYPES = {"pdf": {".pdf"}, "html": {".html", ".htm"}}
LANGUAGES = {
    '.py': 'python', '.pyw': 'python', '.js': 'javascript', '.mjs': 'javascript',
    '.cjs': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
    '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.json': 'json', '.jsonl': 'json',
    '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'ini', '.ini': 'ini', '.cfg': 'ini',
    '.css': 'css', '.xml': 'xml', '.html': 'xml', '.htm': 'xml',
    '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp',
    '.java': 'java', '.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.php': 'php',
    '.sql': 'sql', '.tex': 'latex', '.sty': 'latex', '.cls': 'latex',
    '.md': 'markdown', '.markdown': 'markdown', '.mdown': 'markdown',
    '.diff': 'diff', '.patch': 'diff', '.r': 'r', '.swift': 'swift', '.kt': 'kotlin',
}
TYPES['markdown'] = {'.md', '.markdown', '.mdown'}
TYPES['code'] = set(LANGUAGES) - TYPES['markdown'] - TYPES['html']
# Fixed upstream releases, verified before caching. Browser requests stay on localhost.
TEXT_ASSETS = {
    'highlight.js': ('@highlightjs/cdn-assets@11.12.0/highlight.min.js',
                     '8ab71eb09c51f501e5e25157d9cff100e46cc29bcbfc744d0b746d451fca7f53'),
    'latex.js': ('@highlightjs/cdn-assets@11.12.0/languages/latex.min.js',
                 '12c8743607535b327bcebd954b0228cf39b7844704123319a7fb594a7db94ce7'),
    'marked.js': ('marked@18.1.1/lib/marked.umd.js',
                  'b82b9334406d8bdd16b6236c08de1cb65b2a859873ca9503d9cc0b292ca3c12a'),
    'purify.js': ('dompurify@3.4.17/dist/purify.min.js',
                  'cd37898f9782adf54820c413191b5691803f0f137c799d6edcfd38523b4c2c31'),
}
PDFJS_VERSION = '6.4.299'
PDFJS_SHA256 = 'f2245eb7ef3f674c872fe568a177bfec15874f5c034613e55d8e307f93ebd86d'


def text_asset(name):
    """Download on demand; no startup delay or Python package dependency."""
    if name not in TEXT_ASSETS:
        raise FileNotFoundError(name)
    upstream, checksum = TEXT_ASSETS[name]
    cache = Path(os.environ.get('XDG_CACHE_HOME', str(Path.home() / '.cache')))
    cache = cache / 'project-file-browser' / 'text-assets'
    target = cache / (checksum + '.js')
    if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == checksum:
        return target
    cache.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen('https://cdn.jsdelivr.net/npm/' + upstream, timeout=20) as response:
        data = response.read(2 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != checksum:
        raise ValueError('Text viewer asset checksum mismatch')
    with tempfile.NamedTemporaryFile(dir=cache, delete=False) as output:
        temporary = Path(output.name)
        output.write(data)
    try:
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return target


def prepare_pdfjs():
    """Cache an integrity-checked upstream viewer; no npm/pip install needed."""
    cache_base = Path(os.environ.get('XDG_CACHE_HOME', str(Path.home() / '.cache')))
    destination = cache_base / 'project-file-browser' / ('pdfjs-' + PDFJS_VERSION)
    if (destination / 'web' / 'viewer.html').is_file():
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    url = (f'https://github.com/mozilla/pdf.js/releases/download/v{PDFJS_VERSION}/'
           f'pdfjs-{PDFJS_VERSION}-dist.zip')
    print('Preparing PDF viewer (one-time download from Mozilla)…', flush=True)
    with tempfile.TemporaryDirectory(dir=destination.parent) as temp:
        archive = Path(temp) / 'pdfjs.zip'
        digest, size = hashlib.sha256(), 0
        with urllib.request.urlopen(url, timeout=30) as source, archive.open('wb') as output:
            while block := source.read(256 * 1024):
                size += len(block)
                if size > 64 * 1024 * 1024:
                    raise ValueError('PDF viewer download exceeds expected size')
                digest.update(block)
                output.write(block)
        if digest.hexdigest() != PDFJS_SHA256:
            raise ValueError('PDF viewer download checksum mismatch')
        extracted = Path(temp) / 'viewer'
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                if not (extracted / member.filename).resolve().is_relative_to(extracted.resolve()):
                    raise ValueError('Invalid PDF viewer archive path')
            bundle.extractall(extracted)
        if not (extracted / 'web' / 'viewer.html').is_file():
            raise ValueError('PDF viewer archive is incomplete')
        try:
            extracted.rename(destination)
        except OSError:
            if not (destination / 'web' / 'viewer.html').is_file():
                raise
    return destination


PAGE = r'''<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Project Files</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--panel:#fff;--text:#202937;--muted:#727c8c;--line:#e4e8ef;--hover:#f0f3f8;--accent:#315de5;--selected:#eaf0ff;--shadow:0 4px 20px #17233b08}
@media(prefers-color-scheme:dark){:root{--bg:#13171f;--panel:#1a202b;--text:#e3e9f2;--muted:#98a5b8;--line:#2a3444;--hover:#242e3e;--accent:#91b1ff;--selected:#263754;--shadow:none}}
*{box-sizing:border-box}body{margin:0;height:100dvh;display:flex;flex-direction:column;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
button,input,select{font:inherit;color:inherit}button,a,input,select{outline-offset:3px}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}button,a{touch-action:manipulation}
main{display:flex;min-height:0;flex:1;gap:0;padding:8px}aside{width:330px;min-width:230px;max-width:55vw;flex-shrink:0;overflow:hidden;background:var(--panel);border:1px solid var(--line);border-radius:10px;display:flex;flex-direction:column}.side-controls{padding:12px 12px 8px;flex:none}.side-brand{display:flex;align-items:center;gap:5px;margin-bottom:10px}.root{flex:1;min-width:0;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.plain{display:grid;place-items:center;flex:none;width:28px;height:28px;border:0;background:none;color:var(--muted);border-radius:5px;font-size:18px}.plain:hover{background:var(--hover);color:var(--text)}
.search{display:flex;align-items:center;gap:8px;background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:7px 10px}.search:focus-within{border-color:var(--accent)}.search input{width:100%;min-width:0;border:0;outline:none;background:none;font-size:13px}.toolbar{display:flex;align-items:center;gap:8px;margin-top:8px}.toolbar select{flex:1;min-width:0}.button,select{border:1px solid var(--line);background:var(--panel);border-radius:6px;padding:5px 8px;text-decoration:none}.button:hover{background:var(--hover)}.actions{display:flex;gap:5px;flex:none}.actions .button{display:grid;place-items:center;width:30px;height:30px;padding:0;font-size:18px;line-height:1}.side-head{padding:2px 13px 7px;font-size:11px;color:var(--muted);border-bottom:1px solid var(--line)}#entries{flex:1;min-height:0;overflow:auto;padding:6px 5px}.row{width:100%;display:flex;align-items:center;gap:7px;text-align:left;border:0;border-radius:6px;background:none;padding:7px 9px;color:var(--text)}.row:hover{background:var(--hover)}.row.active{background:var(--selected);color:var(--accent)}.caret{width:11px;flex:none;font-size:10px;color:var(--muted)}.icon{width:28px;flex:none;font-size:10px;font-weight:700;color:var(--accent)}.filename{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.size{color:var(--muted);font-size:10px;flex:none}.children{margin-left:13px;padding-left:5px;border-left:1px solid var(--line)}.search-result{display:block;padding:9px 10px}.result-name{display:flex;gap:9px;align-items:center}.result-path{display:block;margin:3px 0 0 37px;font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.note{padding:15px 12px;font-size:12px;color:var(--muted)}.side-foot{flex:none;padding:6px 12px;border-top:1px solid var(--line);color:var(--muted);font-size:11px}
.viewer{position:relative;display:flex;flex-direction:column;flex:1;min-width:0;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}.preview{position:relative;flex:1;min-height:0;background:var(--bg)}iframe{display:block;border:0;width:100%;height:100%;background:white}.empty{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:30px}.empty .symbol{font-size:36px;color:var(--accent);margin-bottom:10px}.empty h1{font-size:20px;font-weight:600;margin:0 0 8px}.empty p{color:var(--muted);margin:0;max-width:420px;font-size:13px}[hidden]{display:none!important}.error{color:#c95252}
.viewer.is-expanded{position:fixed;inset:0;z-index:1000;width:100%;height:100%;min-height:0;border:0;border-radius:0;background:var(--panel)}#exitExpanded{position:absolute;bottom:14px;left:14px;z-index:2;box-shadow:0 2px 10px #0003;white-space:nowrap}#expandPreview[aria-pressed="true"]{border-color:var(--accent);color:var(--accent)}
.splitter{position:relative;flex:0 0 10px;align-self:stretch;cursor:col-resize;touch-action:none;outline-offset:-2px}.splitter::after{content:'';position:absolute;top:8px;bottom:8px;left:4px;width:2px;border-radius:2px;background:transparent;transition:background .12s}.splitter:hover::after,.splitter:focus-visible::after,body.is-resizing .splitter::after{background:var(--accent)}body.is-resizing{user-select:none;cursor:col-resize}body.is-resizing::after{content:'';position:fixed;inset:0;z-index:2000;cursor:col-resize}body.is-resizing iframe{pointer-events:none}
@media(max-width:850px){aside{width:260px}main{padding:5px}}
@media(max-width:560px){main{flex-direction:column;gap:5px}.splitter{display:none}aside{width:100%!important;max-width:none;height:36%;min-height:200px;resize:vertical}.side-foot{display:none}.viewer{min-height:200px}.side-controls{padding:8px}.side-brand{margin-bottom:6px}}
.root-picker{display:flex;gap:5px;margin-bottom:4px}.root-picker select{flex:1;min-width:0}.root-path{font-size:11px;color:var(--muted);overflow-wrap:anywhere;margin:0 0 10px;max-height:48px;overflow:auto}dialog{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:10px;width:min(680px,94vw);max-height:85vh;padding:20px}dialog::backdrop{background:#0006}.root-record{padding:10px 0;border-bottom:1px solid var(--line)}.root-record strong,.root-record small{display:block;overflow-wrap:anywhere}.root-record small{color:var(--muted)}.root-record button{margin:5px 5px 0 0}.root-form{display:grid;gap:8px;margin:16px 0}.root-form label{display:grid;gap:3px}.root-form input{padding:7px;background:var(--bg);border:1px solid var(--line);border-radius:5px}.dialog-head{display:flex;align-items:center;justify-content:space-between}.dialog-head h2{margin:0;font-size:18px}
.primary{background:var(--accent);border-color:var(--accent);color:var(--panel)}.primary:hover{filter:brightness(.94);background:var(--accent)}.add-folder{margin:16px 0}.path-field{display:flex;gap:6px}.path-field input{flex:1;min-width:0}details summary{font-size:12px;color:var(--muted);cursor:pointer}dialog.is-selecting{width:min(760px,96vw)}.folder-hint{font-size:13px;color:var(--muted);margin:12px 0}.folder-places{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}.folder-places button{font-size:12px}.folder-location{display:flex;gap:6px}.folder-location input,.folder-options>input,.folder-name input{min-width:0;border:1px solid var(--line);background:var(--bg);color:var(--text);border-radius:6px;padding:7px 9px;font:inherit}.folder-location input{flex:1;font-size:13px}.folder-breadcrumbs{display:flex;gap:2px;overflow:auto;align-items:center;padding:7px 0;white-space:nowrap}.folder-breadcrumbs button{border:0;background:none;color:var(--muted);padding:3px 5px;font-size:12px}.folder-breadcrumbs button:last-child{color:var(--text);font-weight:600}.folder-breadcrumbs button:hover{background:var(--hover);border-radius:4px}.folder-options{display:flex;gap:12px;align-items:center;margin:2px 0 8px}.folder-options>input{flex:1;font-size:12px}.folder-options label{font-size:12px;white-space:nowrap;color:var(--muted)}.folder-list{height:clamp(150px,36vh,360px);overflow:auto;border:1px solid var(--line);border-radius:7px;padding:4px}.folder-entry{display:flex;width:100%;gap:10px;align-items:center;text-align:left;border:0;background:none;padding:7px 9px;border-radius:5px;color:var(--text);font-size:13px}.folder-entry:hover{background:var(--hover)}.folder-entry .folder-icon{width:24px;flex:none;color:var(--accent);font-size:11px;font-weight:600}.folder-entry .folder-entry-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.folder-entry small{color:var(--muted);font-size:11px}.folder-entry.is-file{color:var(--muted);cursor:default}.folder-entry.is-file:hover{background:none}.folder-entry.is-file .folder-icon{color:var(--muted);font-weight:400}.folder-counts,.folder-selection{font-size:12px;color:var(--muted);overflow-wrap:anywhere;margin:7px 0}.folder-name{display:flex;gap:10px;align-items:center;font-size:13px;margin:12px 0 6px}.folder-name input{flex:1}.folder-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}#folderError{font-size:12px;margin:8px 0}@media(max-width:560px){dialog{padding:14px}.folder-options{gap:6px}.folder-location input{width:0}.folder-places{gap:4px}.folder-entry small{display:none}}
</style></head><body>
<main><aside id="fileSidebar" aria-label="파일 탐색"><div class="side-controls">
<div class="side-brand"><strong class="root" id="rootName">프로젝트 파일</strong><button class="plain" id="home" title="검색을 닫고 프로젝트 루트 보기" aria-label="처음으로">⌂</button><button class="plain" id="refresh" title="목록과 선택한 파일 새로고침" aria-label="새로고침">↻</button></div>
<div class="root-picker"><select id="rootSelect" aria-label="루트 폴더 선택"></select><button class="button" id="manageRoots" title="루트 등록·수정·제거">루트 관리</button></div><div class="root-path" id="rootPath"></div>
<div class="search"><span aria-hidden="true">⌕</span><input id="search" type="search" placeholder="파일명·경로 검색" aria-label="파일명 또는 경로 검색" title="하위 폴더 포함 · Ctrl+K / Cmd+K"></div>
<div class="toolbar"><select id="type" aria-label="파일 형식"><option value="all">전체 파일</option><option value="pdf">PDF</option><option value="html">HTML</option><option value="markdown">Markdown</option><option value="code">코드</option></select><div class="actions" id="actions" hidden><button class="button" id="expandPreview" aria-pressed="false" aria-label="크게 보기" title="크게 보기 · Orca 화면 유지 · Esc로 돌아가기">⛶</button><button class="button" id="copy" aria-label="링크 복사" title="링크 복사">⧉</button><a class="button" id="open" target="_blank" rel="noopener" aria-label="새 탭에서 열기" title="새 탭에서 열기">↗</a></div></div>
</div><div class="side-head" id="listLabel">폴더</div><nav id="entries" aria-label="파일과 폴더" aria-busy="true"></nav><div class="side-foot" id="status" role="status">파일 목록을 불러오는 중…</div></aside>
<div class="splitter" id="sidebarResize" role="separator" aria-label="파일 목록 너비 조절" aria-orientation="vertical" aria-controls="fileSidebar" tabindex="0" title="드래그로 파일 목록 너비 조절 · 방향키로도 조절 가능"></div>
<section class="viewer" id="viewer" aria-label="파일 미리보기"><div class="preview"><div class="empty" id="empty"><div><div class="symbol">▤</div><h1>찾고, 바로 열어보세요</h1><p>폴더를 펼치거나 파일명으로 검색하세요.<br>PDF, HTML, Markdown과 코드를 바로 볼 수 있습니다.</p></div></div><iframe id="preview" title="선택한 파일 미리보기" hidden></iframe></div><button class="button" id="exitExpanded" hidden title="기본 보기 · Esc" aria-label="기본 보기">↙ 기본 보기 <small>Esc</small></button></section></main>
<dialog id="rootsDialog" aria-labelledby="rootsTitle">
<div class="dialog-head"><h2 id="rootsTitle">루트 폴더 관리</h2><button class="button" id="closeRoots">닫기</button></div>
<div id="rootManagement"><p>이 서버의 폴더를 찾아 연결하세요. 연결을 제거해도 원본 파일은 유지됩니다.</p>
<div id="rootRecords"></div><button class="button primary add-folder" id="browseFolder">＋ 폴더 찾아 연결…</button>
<details id="manualRoot"><summary>경로 직접 입력</summary><form class="root-form" id="rootForm">
<label>이름<input id="rootLabel" required maxlength="120" placeholder="논문"></label>
<label>서버 경로<span class="path-field"><input id="rootDirectory" required placeholder="/mnt/data/papers"><button class="button" type="button" id="browseRootDirectory">찾아보기…</button></span></label>
<div><button class="button" type="submit" id="saveRoot">등록</button> <button class="button" type="button" id="cancelRootEdit" hidden>수정 취소</button></div></form></details>
<p id="rootMessage" role="status"></p></div>
<section id="folderPicker" hidden aria-label="서버 폴더 선택">
<p class="folder-hint">폴더를 열어 내용을 확인한 뒤 연결하세요.</p>
<div class="folder-places" id="folderPlaces" aria-label="자주 쓰는 위치"></div>
<form id="folderLocationForm" class="folder-location"><button class="button" id="folderUp" type="button" title="상위 폴더" aria-label="상위 폴더">↑</button><input id="folderLocation" aria-label="서버 폴더 경로" autocomplete="off" spellcheck="false"><button class="button" type="submit">이동</button></form>
<nav id="folderBreadcrumbs" class="folder-breadcrumbs" aria-label="현재 폴더 경로"></nav>
<div class="folder-options"><input id="folderFilter" type="search" placeholder="현재 폴더에서 이름 찾기" aria-label="현재 폴더에서 이름 찾기"><label><input id="folderHidden" type="checkbox"> 숨김 표시</label></div>
<div id="folderEntries" class="folder-list" aria-label="폴더 내용" aria-busy="false"></div>
<div class="folder-counts" id="folderCounts"></div><p id="folderError" class="error" role="status" hidden></p>
<label class="folder-name">표시 이름<input id="folderLabel" maxlength="120" placeholder="선택한 폴더 이름"></label>
<div class="folder-selection" id="folderSelection"></div><div class="folder-footer"><button class="button" id="cancelFolder">취소</button><button class="button primary" id="chooseFolder" disabled>이 폴더 연결</button></div>
</section></dialog>
<script>
'use strict';
const $=id=>document.getElementById(id), entries=$('entries'), input=$('search'), type=$('type');
const state={cache:new Map(),expanded:new Set(['']),selected:null,generation:0,timer:null,controller:null,pdfjs:false,previewExpanded:false,roots:[],root:'project',token:null,editRoot:null};
const initial=new URLSearchParams(location.search).get('path');
const initialRoot=new URLSearchParams(location.search).get('root');
const nodeKey=(root,path)=>JSON.stringify([root,path]);
const rootLabel=id=>state.roots.find(r=>r.id===id)?.name||id;
const selectionKey=()=> 'fbrowse-root:'+state.project;

const sidebar=$('fileSidebar'),splitter=$('sidebarResize'),narrowLayout=matchMedia('(max-width:560px)');
let sidebarDrag=null;
function sidebarBounds(){return {min:230,max:Math.max(230,Math.min(innerWidth*.55,document.querySelector('main').clientWidth-280))};}
function resizeSidebar(width){
  const {min,max}=sidebarBounds();width=Math.max(min,Math.min(Math.floor(max),Math.round(width)));
  sidebar.style.width=width+'px';syncSidebarSize();
}
function syncSidebarSize(){
  const {min,max}=sidebarBounds();splitter.setAttribute('aria-valuemin',String(min));splitter.setAttribute('aria-valuemax',String(Math.floor(max)));
  splitter.setAttribute('aria-valuenow',String(Math.round(sidebar.getBoundingClientRect().width)));
}
function saveSidebarSize(){try{localStorage.setItem('project-files-sidebar-width',String(sidebar.getBoundingClientRect().width));}catch{}}
function finishSidebarResize(){
  if(!sidebarDrag)return;const id=sidebarDrag.id;sidebarDrag=null;document.body.classList.remove('is-resizing');
  if(splitter.hasPointerCapture(id))splitter.releasePointerCapture(id);saveSidebarSize();
}
splitter.addEventListener('pointerdown',event=>{
  if(event.button!==0||narrowLayout.matches||sidebarDrag)return;
  event.preventDefault();sidebarDrag={id:event.pointerId,x:event.clientX,width:sidebar.getBoundingClientRect().width};
  splitter.setPointerCapture(event.pointerId);splitter.focus();document.body.classList.add('is-resizing');
});
splitter.addEventListener('pointermove',event=>{if(sidebarDrag?.id===event.pointerId)resizeSidebar(sidebarDrag.width+event.clientX-sidebarDrag.x);});
for(const name of ['pointerup','pointercancel','lostpointercapture'])splitter.addEventListener(name,finishSidebarResize);
window.addEventListener('blur',finishSidebarResize);
splitter.addEventListener('keydown',event=>{
  const {min,max}=sidebarBounds(),step=event.shiftKey?40:12;
  const width=sidebar.getBoundingClientRect().width;
  const next={ArrowLeft:width-step,ArrowRight:width+step,Home:min,End:max}[event.key];
  if(next===undefined)return;event.preventDefault();resizeSidebar(next);saveSidebarSize();
});
window.addEventListener('resize',()=>{finishSidebarResize();if(!narrowLayout.matches)resizeSidebar(sidebar.getBoundingClientRect().width);});
try{const saved=Number(localStorage.getItem('project-files-sidebar-width'));if(saved>0&&!narrowLayout.matches)resizeSidebar(saved);}catch{}
syncSidebarSize();

const bytes=n=>n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':(n/1048576).toFixed(1)+' MB';
const fileURL=(path,root=state.root)=>'/roots/'+encodeURIComponent(root)+'/files/'+path.split('/').map(encodeURIComponent).join('/');
const icon=e=>e.kind==='directory'?'DIR':({pdf:'PDF',html:'HTM',markdown:'MD',code:'CODE',text:'TXT'})[e.category]||'FILE';
const previewURL=entry=>['pdf','html','media'].includes(entry.category)?fileURL(entry.path,entry.root_id):'/_preview?'+new URLSearchParams({root:entry.root_id,path:entry.path});
const make=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
async function api(url,signal){const response=await fetch(url,{cache:'no-store',signal});const data=await response.json();if(!response.ok)throw Error(data.error||'요청에 실패했습니다');return data;}
function note(message,error=false){entries.replaceChildren(make('div',error?'note error':'note',message));}
function row(entry,result=false){
  const button=make('button','row'+(result?' search-result':'')+(state.selected?.path===entry.path&&state.selected?.root_id===entry.root_id?' active':''));
  button.type='button';button.dataset.path=entry.path;button.dataset.root=entry.root_id;button.title=rootLabel(entry.root_id)+' · '+(state.roots.find(r=>r.id===entry.root_id)?.path||'')+'/'+entry.path;
  if(entry.kind==='directory'){
    button.setAttribute('aria-expanded',String(state.expanded.has(nodeKey(entry.root_id,entry.path))));
    button.append(make('span','caret',state.expanded.has(nodeKey(entry.root_id,entry.path))?'▾':'▸'),make('span','icon','DIR'),make('span','filename',entry.name));
    button.onclick=()=>toggle(entry.path,entry.root_id);return button;
  }
  const line=result?make('span','result-name'):button;
  if(!result)line.append(make('span','caret',''));
  line.append(make('span','icon',icon(entry)),make('span','filename',entry.name),make('span','size',bytes(entry.size)));
  if(result){button.append(line,make('span','result-path',rootLabel(entry.root_id)+' · '+entry.path));}
  button.onclick=()=>select(entry);return button;
}
function drawTree(){
  entries.replaceChildren();let files=0;
  function branch(path,container){
    const data=state.cache.get(nodeKey(state.root,path));
    if(data?.error){container.append(make('div','note error',data.error));return;}
    if(!data){container.append(make('div','note','불러오는 중…'));return;}
    const visible=data.entries.filter(e=>e.kind==='directory'||type.value==='all'||e.category===type.value);
    if(!visible.length)container.append(make('div','note','표시할 파일이 없습니다'));
    for(const entry of visible){
      container.append(row(entry));if(entry.kind!=='directory')files++;
      if(entry.kind==='directory'&&state.expanded.has(nodeKey(entry.root_id,entry.path))){const children=make('div','children');container.append(children);branch(entry.path,children);}
    }
  }
  const root=state.roots.find(r=>r.id===state.root);
  if(!root?.connected){note('연결 안 됨 · 서버 경로를 확인한 뒤 새로고침하세요.');$('status').textContent='연결 안 됨';return;}
  branch('',entries);$('listLabel').textContent='폴더';$('status').textContent=`표시된 파일 ${files}개 · 읽기 전용`;
}
async function toggle(path,root){
  const key=nodeKey(root,path);
  if(state.expanded.has(key)){state.expanded.delete(key);drawTree();return;}
  state.expanded.add(key);drawTree();
  try{state.cache.set(key,await api('/api/list?'+new URLSearchParams({root,path})));if(!input.value.trim())drawTree();}
  catch(error){state.expanded.delete(key);$('status').textContent=error.message;if(!input.value.trim())drawTree();}
}
function renderRoots(){
  $('rootSelect').replaceChildren(...state.roots.map(root=>{const option=make('option','',root.name+(root.connected?'':' · 연결 안 됨'));option.value=root.id;option.title=root.path;return option;}));
  $('rootSelect').value=state.root;
  const root=state.roots.find(r=>r.id===state.root);$('rootPath').textContent=root?.path||'';$('rootPath').title=root?.path||'';
}
async function refreshRoots(signal){
  const info=await api('/api/info',signal);state.roots=info.roots;state.token=info.config_token;state.pdfjs=info.pdfjs;
  state.project=info.root;$('rootName').textContent=info.name;$('rootName').title=info.root;
  if(!state.roots.some(r=>r.id===state.root))state.root='project';
  renderRoots();
}
function resetPreview(){state.selected=null;$('preview').src='about:blank';$('preview').hidden=true;$('empty').hidden=false;$('actions').hidden=true;}
$('rootSelect').onchange=()=>{state.root=$('rootSelect').value;input.value='';resetPreview();renderRoots();try{localStorage.setItem(selectionKey(),state.root);}catch{}history.replaceState(null,'','/?'+new URLSearchParams({root:state.root}));update();};
function cancelRootEdit(){state.editRoot=null;$('rootForm').reset();$('saveRoot').textContent='등록';$('cancelRootEdit').hidden=true;$('manualRoot').open=false;}
$('cancelRootEdit').onclick=cancelRootEdit;
function drawRootRecords(){
  $('rootRecords').replaceChildren(...state.roots.map(root=>{
    const record=make('div','root-record');record.append(make('strong','',root.name+(root.connected?'':' · 연결 안 됨')),make('small','',root.path));
    if(root.id==='project'){record.append(make('small','','기본 프로젝트 · 실행한 폴더'));return record;}
    const edit=make('button','button','수정');edit.type='button';edit.onclick=()=>{state.editRoot=root.id;$('rootLabel').value=root.name;$('rootDirectory').value=root.path;$('saveRoot').textContent='저장';$('cancelRootEdit').hidden=false;$('manualRoot').open=true;$('rootLabel').focus();};
    const remove=make('button','button','연결 제거');remove.type='button';remove.onclick=()=>saveRoots({operation:'remove',id:root.id});record.append(edit,remove);return record;
  }));
}
async function saveRoots(data){
  $('rootMessage').textContent='저장 중…';
  try{
    const response=await fetch('/api/roots',{method:'POST',headers:{'Content-Type':'application/json','X-Fbrowse-Token':state.token},body:JSON.stringify(data)});
    const result=await response.json();if(!response.ok)throw Error(result.error);
    if(data.id===state.selected?.root_id)resetPreview();
    if(data.operation==='add'){const added=result.roots.find(root=>!state.roots.some(existing=>existing.id===root.id));if(added){state.root=added.id;input.value='';resetPreview();try{localStorage.setItem(selectionKey(),state.root);}catch{}history.replaceState(null,'','/?'+new URLSearchParams({root:state.root}));}}
    cancelRootEdit();await refreshRoots();drawRootRecords();state.cache.clear();await update(true);$('rootMessage').textContent='저장했습니다.';return true;
  }catch(error){$('rootMessage').textContent=error.message;return false;}
}
$('rootForm').onsubmit=event=>{event.preventDefault();saveRoots({operation:state.editRoot?'edit':'add',id:state.editRoot,name:$('rootLabel').value,path:$('rootDirectory').value});};
$('manageRoots').onclick=async()=>{await refreshRoots();drawRootRecords();$('rootMessage').textContent='';$('rootsDialog').showModal();};
$('closeRoots').onclick=()=>{$('rootsDialog').close();};
$('rootsDialog').addEventListener('close',()=>{closeFolderPicker();cancelRootEdit();});
let folderData=null,folderGeneration=0,folderController=null,folderCustomName=false;
function closeFolderPicker(){
  folderGeneration++;folderController?.abort();$('folderPicker').hidden=true;$('rootManagement').hidden=false;$('rootsDialog').classList.remove('is-selecting');$('rootsTitle').textContent='루트 폴더 관리';
}
function folderFailure(message){$('folderError').textContent=message;$('folderError').hidden=!message;}
function drawFolderEntries(){
  const query=$('folderFilter').value.toLocaleLowerCase(),items=folderData.entries.filter(entry=>entry.name.toLocaleLowerCase().includes(query));
  $('folderEntries').replaceChildren(...items.map(entry=>{
    const node=make(entry.kind==='directory'?'button':'div','folder-entry'+(entry.kind==='file'?' is-file':''));
    node.title=entry.path||entry.name;node.dataset.name=entry.name;
    node.append(make('span','folder-icon',entry.kind==='directory'?'DIR':'FILE'),make('span','folder-entry-name',entry.name));
    if(entry.kind==='directory'){node.type='button';node.disabled=!entry.readable;node.append(make('small','',entry.readable?(entry.symlink?'연결 폴더 ↗':'열기 →'):'접근 불가'));node.onclick=()=>navigateFolders(entry.path);}
    else node.append(make('small','','파일 · 참고용'));
    return node;
  }));
  if(!items.length)$('folderEntries').append(make('div','note',query?'이름이 일치하는 항목이 없습니다.':'빈 폴더입니다. 이 폴더도 연결할 수 있습니다.'));
  $('folderCounts').textContent=`폴더 ${folderData.counts.directory}개 · 파일 ${folderData.counts.file}개`+(folderData.truncated?' · 처음 2,000개 표시':'');
}
async function navigateFolders(path){
  folderController?.abort();const controller=new AbortController();folderController=controller;
  const generation=++folderGeneration;$('folderEntries').setAttribute('aria-busy','true');$('chooseFolder').disabled=true;folderFailure('');
  try{
    const response=await fetch('/api/folders',{method:'POST',headers:{'Content-Type':'application/json','X-Fbrowse-Token':state.token},body:JSON.stringify({path,show_hidden:$('folderHidden').checked}),signal:controller.signal});
    const data=await response.json();if(!response.ok)throw Error(data.error);
    if(generation!==folderGeneration)return false;
    folderData=data;$('folderLocation').value=data.path;$('folderSelection').textContent='선택할 폴더: '+data.path;
    $('folderUp').disabled=data.path===data.parent;$('folderFilter').value='';
    if(!folderCustomName)$('folderLabel').value=data.name;
    $('folderPlaces').replaceChildren(...data.places.map(place=>{const button=make('button','button',place.name);button.type='button';button.title=place.path;button.onclick=()=>navigateFolders(place.path);return button;}));
    const parts=data.path.split('/').filter(Boolean),crumbs=[{name:'/',path:'/'}];let accumulated='';
    for(const part of parts){accumulated+='/'+part;crumbs.push({name:part,path:accumulated});}
    $('folderBreadcrumbs').replaceChildren(...crumbs.flatMap((crumb,index)=>{const button=make('button','',crumb.name);button.type='button';button.title=crumb.path;button.onclick=()=>navigateFolders(crumb.path);return index?[make('span','','›'),button]:[button];}));
    drawFolderEntries();$('folderEntries').scrollTop=0;$('chooseFolder').disabled=false;return true;
  }catch(error){if(error.name!=='AbortError'&&generation===folderGeneration){folderFailure(error.message);}return false;}
  finally{if(generation===folderGeneration)$('folderEntries').setAttribute('aria-busy','false');}
}
async function openFolderPicker(){
  folderData=null;folderCustomName=Boolean($('rootLabel').value.trim());$('folderLabel').value=$('rootLabel').value.trim();$('folderFilter').value='';$('folderEntries').replaceChildren(make('div','note','폴더를 불러오는 중…'));$('folderCounts').textContent='';$('folderSelection').textContent='';
  $('folderPicker').hidden=false;$('rootManagement').hidden=true;$('rootsDialog').classList.add('is-selecting');$('rootsTitle').textContent='연결할 폴더 선택';$('chooseFolder').textContent=state.editRoot?'이 폴더로 변경':'이 폴더 연결';
  const requested=$('rootDirectory').value.trim()||state.roots.find(root=>root.id===state.root)?.path||state.project;
  const openingGeneration=folderGeneration+1,loaded=await navigateFolders(requested);
  if(!loaded&&openingGeneration===folderGeneration&&!$('folderPicker').hidden&&requested!==state.project){if(await navigateFolders(state.project))folderFailure('기존 경로에 접근할 수 없어 프로젝트 폴더를 표시합니다.');}
  if(!$('folderPicker').hidden)$('folderLocation').focus();
}
$('browseFolder').onclick=()=>{cancelRootEdit();openFolderPicker();};
$('browseRootDirectory').onclick=openFolderPicker;
$('folderLocationForm').onsubmit=event=>{event.preventDefault();navigateFolders($('folderLocation').value.trim());};
$('folderUp').onclick=()=>{if(folderData)navigateFolders(folderData.parent);};
$('folderHidden').onchange=()=>{if(folderData)navigateFolders(folderData.path);};
$('folderFilter').oninput=()=>{if(folderData)drawFolderEntries();};
$('folderLabel').oninput=()=>{folderCustomName=Boolean($('folderLabel').value.trim());};
$('cancelFolder').onclick=closeFolderPicker;
$('chooseFolder').onclick=async()=>{
  if(!folderData)return;
  $('chooseFolder').disabled=true;
  const saved=await saveRoots({operation:state.editRoot?'edit':'add',id:state.editRoot,name:$('folderLabel').value.trim()||folderData.name,path:folderData.path});
  if(saved){closeFolderPicker();$('closeRoots').focus();}else{folderFailure($('rootMessage').textContent);$('chooseFolder').disabled=false;}
};
$('rootsDialog').addEventListener('cancel',event=>{if(!$('folderPicker').hidden){event.preventDefault();closeFolderPicker();}});
async function update(refresh=false){
  clearTimeout(state.timer);state.controller?.abort();const controller=new AbortController();state.controller=controller;
  const generation=++state.generation,query=input.value.trim();entries.setAttribute('aria-busy','true');
  try{
    await refreshRoots(controller.signal);
    state.expanded.add(nodeKey(state.root,''));
    if(!state.roots.find(r=>r.id===state.root)?.connected){drawTree();return;}
    if(query){
      $('listLabel').textContent='검색 결과';$('status').textContent='하위 폴더까지 검색 중…';
      const data=await api('/api/search?'+new URLSearchParams({root:state.root,q:query,type:type.value,refresh:refresh?'1':'0'}),controller.signal);
      if(generation!==state.generation)return;
      entries.replaceChildren(...data.entries.map(e=>row(e,true)));
      if(!data.entries.length)note('일치하는 파일이 없습니다');
      $('status').textContent=`${data.total}개 결과`+(data.total>data.entries.length?` · 처음 ${data.entries.length}개 표시`:'')+(data.skipped?' · 일부 폴더 접근 불가':'');
    }else{
      const paths=[...state.expanded].map(key=>JSON.parse(key)).filter(([root])=>root===state.root);
      const loaded=await Promise.all(paths.map(async ([root,path])=>[nodeKey(root,path),await api('/api/list?'+new URLSearchParams({root,path}),controller.signal).catch(error=>{if(error.name==='AbortError')throw error;return {entries:[],error:error.message};})]));
      if(generation!==state.generation)return;
      for(const [key,data] of loaded)state.cache.set(key,data);
      drawTree();
    }
  }catch(error){if(error.name!=='AbortError'&&generation===state.generation){note(error.message,true);$('status').textContent='새로고침으로 다시 시도하세요';}}
  finally{if(generation===state.generation)entries.setAttribute('aria-busy','false');}
}
function loadPreview(){
  if(!state.selected)return;
  const entry=state.selected,url=fileURL(entry.path,entry.root_id)+'?v='+Date.now();
  $('preview').src=state.pdfjs&&entry.category==='pdf'?'/_pdfjs/web/viewer.html?file='+encodeURIComponent(url)+'#zoom=page-width':previewURL(entry)+(previewURL(entry).includes('?')?'&':'?')+'v='+Date.now();
}
function setPreviewExpanded(expanded){
  state.previewExpanded=expanded;$('viewer').classList.toggle('is-expanded',expanded);
  $('expandPreview').textContent=expanded?'↙':'⛶';
  $('expandPreview').setAttribute('aria-label',expanded?'기본 보기':'크게 보기');
  $('exitExpanded').hidden=!expanded;
  $('expandPreview').setAttribute('aria-pressed',String(expanded));
}
function closeExpandedPreview(){
  setPreviewExpanded(false);$('expandPreview').focus();
}
$('exitExpanded').onclick=closeExpandedPreview;
$('expandPreview').onclick=()=>{
  // Stay inside the web page so Orca's tabs and surrounding UI remain visible.
  setPreviewExpanded(!state.previewExpanded);
};
function handlePreviewEscape(event){
  if(event.key!=='Escape'||!state.previewExpanded)return false;
  event.preventDefault();event.stopPropagation();closeExpandedPreview();return true;
}
$('preview').addEventListener('load',()=>{
  // Keyboard events in the PDF/HTML iframe do not bubble to the parent document.
  try{$('preview').contentWindow.addEventListener('keydown',handlePreviewEscape,true);}catch{}
});
function select(entry){
  state.selected=entry;$('preview').title=entry.name+' 미리보기';$('viewer').setAttribute('aria-label',entry.name+' 미리보기');
  $('empty').hidden=true;$('preview').hidden=false;$('actions').hidden=false;$('open').href=previewURL(entry);loadPreview();
  document.title=entry.name+' · Project Files';
  history.replaceState(null,'','/?'+new URLSearchParams({root:entry.root_id,path:entry.path}));
  for(const node of entries.querySelectorAll('button[data-path]'))node.classList.toggle('active',node.dataset.path===entry.path&&node.dataset.root===entry.root_id);
}
input.oninput=()=>{state.controller?.abort();state.generation++;clearTimeout(state.timer);state.timer=setTimeout(()=>update(),200);};
type.onchange=()=>update();$('refresh').onclick=()=>{state.cache.clear();update(true);loadPreview();};
$('home').onclick=()=>{input.value='';state.expanded=new Set([nodeKey(state.root,'')]);update();};
$('copy').onclick=async()=>{const url=new URL('/?'+new URLSearchParams({root:state.selected.root_id,path:state.selected.path}),location.origin).href;try{await navigator.clipboard.writeText(url);$('copy').textContent='✓';$('copy').title='복사됨';setTimeout(()=>{$('copy').textContent='⧉';$('copy').title='링크 복사';},1500);}catch{window.prompt('미리보기 링크를 복사하세요',url);}};
document.addEventListener('keydown',event=>{
  if(handlePreviewEscape(event))return;
  if(state.previewExpanded)return;
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();input.focus();input.select();}
  else if(event.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)){event.preventDefault();input.focus();}
  else if(event.key==='Escape'&&document.activeElement===input){input.value='';update();}
});
(async()=>{
  try{
    await refreshRoots();
    let saved;try{saved=localStorage.getItem(selectionKey());}catch{}
    const preferred=initialRoot||saved;
    if(state.roots.some(r=>r.id===preferred))state.root=preferred;
    renderRoots();state.expanded=new Set([nodeKey(state.root,'')]);
    if(initial){
      const data=await api('/api/entry?'+new URLSearchParams({root:state.root,path:initial}));const parts=data.entry.path.split('/');
      const count=data.entry.kind==='directory'?parts.length:parts.length-1;
      for(let i=1;i<=count;i++)state.expanded.add(nodeKey(state.root,parts.slice(0,i).join('/')));
      if(data.entry.kind==='file')select(data.entry);
    }
  }catch(error){$('status').textContent=error.message;}
  await update();
})();
</script></body></html>'''


TEXT_PAGE = r'''<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>텍스트 미리보기</title><style>
:root{color-scheme:light dark;--bg:#fff;--text:#24292f;--muted:#6e7781;--line:#d8dee4;--soft:#f6f8fa;--accent:#0969da;--keyword:#cf222e;--string:#0a3069;--number:#0550ae;--title:#8250df}
@media(prefers-color-scheme:dark){:root{--bg:#161b22;--text:#e6edf3;--muted:#8b949e;--line:#30363d;--soft:#0d1117;--accent:#79c0ff;--keyword:#ff7b72;--string:#a5d6ff;--number:#79c0ff;--title:#d2a8ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif}header{position:sticky;top:0;z-index:2;display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 14px;border-bottom:1px solid var(--line);background:var(--bg);font-size:12px}#info{flex:1;color:var(--muted)}button,a{font:inherit}button{cursor:pointer;border:1px solid var(--line);background:var(--bg);color:var(--text);padding:4px 9px;border-radius:6px}button:hover,button[aria-pressed="true"]{background:var(--soft);color:var(--accent)}a{color:var(--accent)}#notice{margin:0;padding:8px 16px;background:var(--soft);color:var(--muted);font-size:12px}[hidden]{display:none!important}.source-shell{display:flex;overflow:auto;min-height:calc(100vh - 50px)}pre,code{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}pre{margin:0;font-size:13px;line-height:1.7;tab-size:4}.gutter{position:sticky;left:0;align-self:stretch;flex-shrink:0;user-select:none;text-align:right;padding:18px 12px;background:var(--soft);border-right:1px solid var(--line);color:var(--muted)}.source{padding:18px;min-width:0;flex:1}.source-shell.wrap .source{white-space:pre-wrap;overflow-wrap:anywhere}.gutter span{display:block}article{max-width:1000px;margin:auto;padding:24px 36px 80px;overflow-wrap:break-word}article h1,article h2{border-bottom:1px solid var(--line);padding-bottom:.3em}article h1{font-size:2em}article h2{font-size:1.5em}article h3{font-size:1.25em}article h1,article h2,article h3,article h4{line-height:1.3;margin:1.4em 0 .65em;scroll-margin-top:65px}article>:first-child{margin-top:0}article p,article ul,article ol,article blockquote,article table,article pre{margin:0 0 16px}article pre{padding:16px;background:var(--soft);border-radius:8px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}article code{font-size:.88em;background:var(--soft);border-radius:4px;padding:.15em .35em}article pre code{background:none;padding:0;font-size:13px}article blockquote{padding:0 1em;color:var(--muted);border-left:4px solid var(--line)}article table{display:block;max-width:100%;overflow:auto;border-collapse:collapse}article th,article td{border:1px solid var(--line);padding:6px 13px}article tr:nth-child(even){background:var(--soft)}article img{max-width:100%;height:auto}article hr{border:0;border-top:1px solid var(--line);margin:24px 0}article input[type="checkbox"]{margin-right:6px}.hljs-comment,.hljs-quote{color:var(--muted);font-style:italic}.hljs-keyword,.hljs-selector-tag,.hljs-doctag,.hljs-tag{color:var(--keyword)}.hljs-string,.hljs-regexp,.hljs-template-tag{color:var(--string)}.hljs-number,.hljs-literal,.hljs-attr,.hljs-variable,.hljs-params{color:var(--number)}.hljs-title,.hljs-section,.hljs-type,.hljs-built_in{color:var(--title)}.hljs-meta,.hljs-symbol,.hljs-bullet{color:var(--accent)}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:bold}.hljs-addition{color:#22863a}.hljs-deletion{color:var(--keyword)}@media(max-width:600px){article{padding:18px 16px 50px}.source{padding:14px 10px}.gutter{padding-top:14px;padding-bottom:14px}}
</style></head><body>
<header><span id="info">텍스트를 불러오는 중…</span><button id="mode" hidden aria-pressed="false">원문 보기</button><button id="wrap" aria-pressed="true" title="긴 줄을 화면 너비에 맞춰 자동 줄바꿈">자동 줄바꿈</button><button id="copy">복사</button><a id="raw" target="_blank" rel="noopener">원본 ↗</a></header>
<p id="notice" hidden role="status"></p><div class="source-shell wrap" id="source"><pre class="gutter" id="lines" aria-hidden="true"></pre><pre class="source"><code id="code"></code></pre></div><article id="markdown" hidden></article>
<script>
'use strict';
const $=id=>document.getElementById(id),path=new URLSearchParams(location.search).get('path')||'';
const root=new URLSearchParams(location.search).get('root')||'project';
const filePrefix='/roots/'+encodeURIComponent(root)+'/files/';
const fileURL=filePrefix+path.split('/').map(encodeURIComponent).join('/');
let data=null,rendered=false,sourceMode=false,lineStarts=[],lineNumberFrame=0;
$('raw').href=fileURL;
function notice(text){$('notice').textContent=text;$('notice').hidden=!text;}
function library(name){return new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/_text_assets/'+name+'.js';script.onload=resolve;script.onerror=()=>reject(Error('뷰어 구성 요소를 준비하지 못했습니다'));document.head.append(script);});}
function showMode(){const showMarkdown=rendered&&!sourceMode;$('markdown').hidden=!showMarkdown;$('source').hidden=showMarkdown;$('wrap').hidden=showMarkdown;$('mode').textContent=showMarkdown?'원문 보기':'미리보기';$('mode').setAttribute('aria-pressed',String(sourceMode));}
function highlight(node,language){
  // Keep large source files readable without expensive highlighting or auto-detection.
  if(!window.hljs||!language||node.textContent.length>300000||!hljs.getLanguage(language))return;
  node.innerHTML=hljs.highlight(node.textContent,{language,ignoreIllegals:true}).value;
}
function scheduleLineNumbers(){cancelAnimationFrame(lineNumberFrame);lineNumberFrame=requestAnimationFrame(syncLineNumbers);}
function syncLineNumbers(){
  const code=$('code'),gutter=$('lines');
  if(!data||gutter.hidden||$('source').hidden)return;
  const labels=[...gutter.children];
  if(!$('source').classList.contains('wrap')){for(const label of labels)label.style.height='';return;}
  // Measure caret positions in the highlighted source so wrapping, tabs and wide
  // characters keep their original line numbers without rewriting the code DOM.
  const walker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT),nodes=[];
  while(walker.nextNode())nodes.push(walker.currentNode);
  if(!nodes.length)return;
  const range=document.createRange(),lineHeight=parseFloat(getComputedStyle(code.parentElement).lineHeight);
  let nodeIndex=0,nodeStart=0;
  function topAt(offset){
    while(nodeIndex<nodes.length-1&&offset>=nodeStart+nodes[nodeIndex].length){nodeStart+=nodes[nodeIndex++].length;}
    const node=nodes[nodeIndex],position=Math.min(node.length,Math.max(0,offset-nodeStart));
    range.setStart(node,position);range.setEnd(node,Math.min(node.length,position+1));
    const rect=range.getClientRects()[0];if(rect)return rect.top;
    // A collapsed range on an empty line or after the final newline may have no
    // rectangle; the last real character still tells us the final visual row.
    if(offset===data.text.length&&position>0){
      range.setStart(node,position-1);range.setEnd(node,position);
      const last=range.getClientRects();
      if(last.length)return last[last.length-1].top+(data.text.endsWith('\n')?lineHeight:0);
    }
  }
  const tops=lineStarts.map(offset=>topAt(offset));
  const endTop=topAt(data.text.length);
  // Read all positions before writing any heights, avoiding repeated layout work.
  const heights=tops.map((top,index)=>{
    const next=index+1<tops.length?tops[index+1]:endTop+lineHeight;
    return Number.isFinite(top)&&Number.isFinite(next)&&next>top?next-top:lineHeight;
  });
  labels.forEach((label,index)=>label.style.height=heights[index]+'px');
}
let measuredSourceWidth=0;
new ResizeObserver(([entry])=>{
  if(entry.contentRect.width!==measuredSourceWidth){measuredSourceWidth=entry.contentRect.width;scheduleLineNumbers();}
}).observe($('code').parentElement);
if(document.fonts)document.fonts.ready.then(scheduleLineNumbers);
function renderMarkdown(){
  const article=$('markdown');
  article.innerHTML=DOMPurify.sanitize(marked.parse(data.text,{gfm:true}),{USE_PROFILES:{html:true}});
  const base=new URL(fileURL,location.origin);
  // Resolve images and document links relative to the Markdown file, not this viewer route.
  for(const image of article.querySelectorAll('img[src]')){
    const src=image.getAttribute('src');if(!src.startsWith('data:'))image.src=new URL(src,base).href;
  }
  const headings=new Map();
  for(const heading of article.querySelectorAll('h1,h2,h3,h4,h5,h6')){
    const slug=heading.textContent.toLowerCase().trim().replace(/[^\p{L}\p{N}_\s-]/gu,'').replace(/\s/g,'-');
    const count=headings.get(slug)||0;headings.set(slug,count+1);heading.id=slug+(count?'-'+count:'');
  }
  for(const link of article.querySelectorAll('a[href]')){
    const href=link.getAttribute('href');if(href.startsWith('#'))continue;
    const target=new URL(href,base);
    if(target.origin===location.origin){
      let targetRoot=root,relative;
      const match=target.pathname.match(/^\/roots\/([^/]+)\/files\/(.*)$/);
      if(match){targetRoot=decodeURIComponent(match[1]);relative=decodeURIComponent(match[2]);}
      else relative=decodeURIComponent(target.pathname.replace(/^\/files\//,'').replace(/^\//,''));
      link.href='/?'+new URLSearchParams({root:targetRoot,path:relative});link.target='_top';
    }else{link.target='_blank';link.rel='noopener noreferrer';}
  }
  for(const code of article.querySelectorAll('pre code')){
    const language=[...code.classList].find(c=>c.startsWith('language-'))?.slice(9);
    highlight(code,language);
  }
  rendered=true;$('mode').hidden=false;showMode();
}
$('mode').onclick=()=>{sourceMode=!sourceMode;showMode();scheduleLineNumbers();};
$('wrap').onclick=()=>{const wrap=$('source').classList.toggle('wrap');$('wrap').setAttribute('aria-pressed',String(wrap));scheduleLineNumbers();};
$('copy').onclick=async()=>{if(!data)return;try{await navigator.clipboard.writeText(data.text);$('copy').textContent='복사됨';setTimeout(()=>$('copy').textContent='복사',1200);}catch{notice('복사하려면 원문을 선택하고 Ctrl+C를 누르세요.');}};
(async()=>{
  try{
    const response=await fetch('/api/text?'+new URLSearchParams({root,path}),{cache:'no-store'});data=await response.json();if(!response.ok)throw Error(data.error);
    document.title=path.split('/').pop()+' · 미리보기';$('code').textContent=data.text;
    const count=data.text.split('\n').length;$('info').textContent=(data.language||'텍스트')+' · '+data.encoding+' · '+count.toLocaleString()+'줄';
    lineStarts=[0];for(let index=data.text.indexOf('\n');index!==-1;index=data.text.indexOf('\n',index+1))lineStarts.push(index+1);
    if(count<=20000){const fragment=document.createDocumentFragment();for(let index=0;index<count;index++){const label=document.createElement('span');label.textContent=index+1;fragment.append(label);}$('lines').replaceChildren(fragment);}else $('lines').hidden=true;
    scheduleLineNumbers();
    const highlighting=library('highlight').then(async()=>{if(data.language==='latex')await library('latex');highlight($('code'),data.language);scheduleLineNumbers();});
    if(data.markdown&&data.text.length<=300000){
      const formatting=Promise.all([library('marked'),library('purify')]);
      await Promise.all([formatting,highlighting.catch(()=>{})]);renderMarkdown();
    }else await highlighting;
    if(data.text.length>300000)notice('큰 파일은 전체 원문으로 표시합니다. 문법 색상과 Markdown 서식은 30만 자 이하에서 적용합니다.');
  }catch(error){$('info').textContent=data?.text!==undefined?'원문 미리보기':'미리보기 불가';notice(error.message+(data?.text!==undefined?' · 원문은 그대로 읽을 수 있습니다.':''));}
})();
</script></body></html>'''


class FileBrowserServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, root, show_hidden=False, pdfjs_root=None):
        self.root = Path(root).resolve(strict=True)
        self.show_hidden = show_hidden
        self.pdfjs_root = Path(pdfjs_root).resolve() if pdfjs_root else None
        self.instance_id = uuid.uuid4().hex
        self.config_token = uuid.uuid4().hex
        self.index = []
        self.index_time = 0.0
        self.index_skipped = 0
        self.index_lock = threading.Lock()
        super().__init__(address, FileBrowserHandler)

    def visible(self, parts):
        return not any(part in EXCLUDED or (part.startswith('.') and not self.show_hidden)
                       for part in parts)

    def roots(self):
        return {'project': str(self.root), **{key: item['path'] for key, item in read_config(self.root).items()}}

    def root_info(self):
        records = {'project': {'name': self.root.name, 'path': str(self.root)}, **read_config(self.root)}
        def connected(path):
            try:
                return path.is_dir() and path.resolve(strict=True) == path and os.access(path, os.R_OK | os.X_OK)
            except (OSError, RuntimeError):
                return False
        return [{'id': key, **record, 'connected': connected(Path(record['path']))} for key, record in records.items()]

    def root_path(self, root_id):
        roots = self.roots()
        if root_id not in roots:
            raise PermissionError('Unknown root')
        # Keep the configured path as the boundary even if a mount is unavailable.
        return Path(roots[root_id])

    def browse_folders(self, path=None, show_hidden=False):
        """One-level metadata for the user-invoked folder chooser, never file contents."""
        if path is None:
            directory = self.root
        else:
            if not isinstance(path, str) or not path or '\x00' in path:
                raise ValueError('서버의 폴더 경로를 입력하세요.')
            directory = Path(path).expanduser()
            if not directory.is_absolute():
                raise ValueError('서버의 절대 경로를 입력하세요.')
            directory = directory.resolve(strict=True)
        if not directory.is_dir():
            raise ValueError('폴더를 선택하세요.')
        counts = {'directory': 0, 'file': 0}
        def children():
            with os.scandir(directory) as listing:
                for child in listing:
                    if not show_hidden and child.name.startswith('.'):
                        continue
                    try:
                        if child.is_dir():
                            target = Path(child.path).resolve(strict=True)
                            entry = {'name': child.name, 'kind': 'directory', 'path': str(target),
                                     'readable': os.access(target, os.R_OK | os.X_OK),
                                     'symlink': child.is_symlink()}
                        elif child.is_file():
                            entry = {'name': child.name, 'kind': 'file'}
                        else:
                            continue
                    except (OSError, RuntimeError):
                        continue
                    counts[entry['kind']] += 1
                    yield entry
        entries = heapq.nsmallest(2000, children(), key=lambda e: (e['kind'] != 'directory', e['name'].casefold()))
        places = [('프로젝트', self.root), ('홈', Path.home()), ('/mnt', Path('/mnt')),
                  ('/media', Path('/media')), ('파일시스템 /', Path('/'))]
        return {'path': str(directory), 'parent': str(directory.parent), 'name': directory.name or '/',
                'entries': entries, 'counts': counts, 'truncated': sum(counts.values()) > len(entries),
                'places': [{'name': name, 'path': str(place)} for name, place in places if place.is_dir()]}

    def resolve_path(self, relative, root_id='project', boundary=None):
        if '\\' in relative or '\x00' in relative:
            raise PermissionError('Invalid path')
        parts = Path(relative).parts
        if Path(relative).is_absolute() or '..' in parts or not self.visible(parts):
            raise PermissionError('Path is excluded')
        root = boundary if boundary is not None else self.root_path(root_id)
        target = (root / relative).resolve(strict=True)
        if not target.is_relative_to(root):
            raise PermissionError('Path is outside project')
        if not self.visible(target.relative_to(root).parts):
            raise PermissionError('Path is excluded')
        return target

    def entry(self, path, relative, root_id='project'):
        info = path.stat()
        if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise PermissionError('Not a regular file or directory')
        suffix = Path(relative).suffix.lower()
        category = next((kind for kind, extensions in TYPES.items() if suffix in extensions), 'text')
        if category == 'text' and (mimetypes.guess_type(str(path))[0] or '').startswith(('image/', 'audio/', 'video/')):
            category = 'media'
        return {'name': Path(relative).name or self.root_path(root_id).name, 'path': relative,
                'root_id': root_id,
                'kind': 'directory' if stat.S_ISDIR(info.st_mode) else 'file',
                'size': info.st_size, 'mtime': info.st_mtime, 'category': category}

    def text_preview(self, relative, root_id='project'):
        target = self.resolve_path(relative, root_id)
        if not target.is_file():
            raise PermissionError('Not a regular file')
        content = target.read_bytes()
        encoding = 'utf-8-sig'
        if content.startswith((b'\xff\xfe\x00\x00', b'\x00\x00\xfe\xff')):
            encoding = 'utf-32'
        elif content.startswith((b'\xff\xfe', b'\xfe\xff')):
            encoding = 'utf-16'
        elif b'\x00' in content[:8192]:
            raise UnicodeError('Binary file')
        text = content.decode(encoding).replace('\r\n', '\n').replace('\r', '\n')
        if '\x00' in text:
            raise UnicodeError('Binary file')
        name = Path(relative)
        return {'text': text, 'language': LANGUAGES.get(name.suffix.lower(),
                'makefile' if name.name.lower() in {'makefile', 'gnumakefile'} else
                'dockerfile' if name.name.lower() == 'dockerfile' else ''),
                'markdown': name.suffix.lower() in TYPES['markdown'],
                'encoding': 'UTF-8' if encoding == 'utf-8-sig' else encoding.upper()}

    def list_directory(self, relative, root_id='project'):
        directory = self.resolve_path(relative, root_id)
        if not directory.is_dir():
            raise NotADirectoryError(relative)
        result = []
        for path in directory.iterdir():
            child = (Path(relative) / path.name).as_posix()
            try:
                resolved = self.resolve_path(child, root_id)
                result.append(self.entry(resolved, child, root_id))
            except (OSError, ValueError, RuntimeError):
                continue
        return sorted(result, key=lambda e: (e['kind'] != 'directory', e['name'].casefold()))

    def search(self, query, kind, refresh=False, root_id=None):
        roots = self.roots()
        if root_id is not None and root_id not in roots:
            raise PermissionError('Unknown root')
        if root_id is not None:
            roots = {root_id: roots[root_id]}
        signature = tuple(roots.items())
        with self.index_lock:
            if refresh or signature != getattr(self, 'index_roots', None) or time.monotonic() - self.index_time > 5:
                index, skipped = [], []
                for source, root_path in roots.items():
                    root = Path(root_path)
                    try:
                        if root.resolve(strict=True) != root:
                            raise PermissionError('Root path was replaced with a symlink')
                    except (OSError, RuntimeError) as error:
                        skipped.append(error)
                        continue
                    for directory, dirs, files in os.walk(root, followlinks=False, onerror=skipped.append):
                        dirs[:] = sorted(d for d in dirs if self.visible((d,))
                                         and not (Path(directory) / d).is_symlink())
                        for name in sorted(files):
                            path = Path(directory) / name
                            relative = path.relative_to(root).as_posix()
                            try:
                                resolved = self.resolve_path(relative, source, root)
                                entry = self.entry(resolved, relative, source)
                                if entry['kind'] == 'file':
                                    index.append(entry)
                            except (OSError, ValueError, RuntimeError):
                                continue
                self.index, self.index_skipped = index, len(skipped)
                self.index_roots = signature
                self.index_time = time.monotonic()
            terms = query.casefold().split()
            matches = [entry for entry in self.index
                       if (root_id is None or entry['root_id'] == root_id)
                       and all(term in entry['path'].casefold() for term in terms)
                       and (kind not in TYPES or Path(entry['name']).suffix.lower() in TYPES[kind])]
            return {'entries': matches[:500], 'total': len(matches), 'skipped': self.index_skipped}


class FileBrowserHandler(BaseHTTPRequestHandler):
    server_version = 'fbrowse/' + VERSION

    def do_POST(self):
        try:
            if self.path not in {'/api/roots', '/api/folders'}:
                self.json_response({'error': 'Unknown endpoint'}, status=404)
                return
            if self.headers.get('X-Fbrowse-Token') != self.server.config_token:
                self.json_response({'error': 'Invalid configuration token'}, status=403)
                return
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 16384:
                raise ValueError('Invalid request size')
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError('Invalid configuration request')
            if self.path == '/api/folders':
                self.json_response(self.server.browse_folders(data.get('path'), data.get('show_hidden') is True))
                return
            change_root(self.server.root, data.get('operation'), data.get('id'), data.get('name'), data.get('path'))
            self.json_response({'roots': self.server.root_info()})
        except (ValueError, TypeError, KeyError, OSError, RuntimeError) as error:
            self.json_response({'error': str(error)}, status=400)

    def do_HEAD(self):
        self.handle_request(head=True)

    def do_GET(self):
        self.handle_request()

    def respond(self, status, body, content_type, head=False, extra_headers=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def json_response(self, data, head=False, status=200):
        self.respond(status, json.dumps(data, ensure_ascii=False).encode(),
                     'application/json; charset=utf-8', head)

    def handle_request(self, head=False):
        try:
            url = urlsplit(self.path)
            path = unquote(url.path)
            query = parse_qs(url.query)
            relative = query.get('path', [''])[0]
            root_id = query.get('root', ['project'])[0]
            if path == '/':
                self.respond(200, PAGE.encode(), 'text/html; charset=utf-8', head)
            elif path == '/api/info':
                self.json_response({'name': self.server.root.name, 'root': str(self.server.root),
                                    'pdfjs': self.server.pdfjs_root is not None,
                                    'service': 'project-file-browser',
                                    'instance_id': self.server.instance_id, 'version': VERSION,
                                    'roots': self.server.root_info(), 'config_token': self.server.config_token}, head)
            elif path == '/api/list':
                self.json_response({'entries': self.server.list_directory(relative, root_id)}, head)
            elif path == '/api/entry':
                target = self.server.resolve_path(relative, root_id)
                self.json_response({'entry': self.server.entry(target, relative, root_id)}, head)
            elif path == '/api/text':
                try:
                    self.json_response(self.server.text_preview(relative, root_id), head)
                except UnicodeError:
                    self.json_response({'error': '텍스트로 표시할 수 없는 파일입니다. UTF-8/UTF-16/UTF-32 텍스트를 지원합니다. 원본 링크를 사용하세요.'}, head, 415)
            elif path == '/api/search':
                self.json_response(self.server.search(query.get('q', [''])[0],
                                   query.get('type', ['all'])[0], query.get('refresh') == ['1'], query.get('root', [None])[0]), head)
            elif path.startswith('/api/'):
                self.json_response({'error': '알 수 없는 요청입니다'}, head, 404)
            elif path == '/_preview':
                if not self.server.resolve_path(relative, root_id).is_file():
                    raise PermissionError('Not a regular file')
                self.respond(200, TEXT_PAGE.encode(), 'text/html; charset=utf-8', head)
            elif path.startswith('/_text_assets/'):
                self.stream_file(text_asset(path[len('/_text_assets/'):]), head)
            elif path.startswith('/_pdfjs/'):
                if self.server.pdfjs_root is None:
                    raise FileNotFoundError(path)
                target = (self.server.pdfjs_root / path[len('/_pdfjs/'):]).resolve(strict=True)
                if not target.is_relative_to(self.server.pdfjs_root) or not target.is_file():
                    raise PermissionError('Invalid viewer asset')
                self.stream_file(target, head)
            else:
                # Preserve relative HTML assets; root-relative assets also map to the project root.
                relative = path[len('/files/'):] if path.startswith('/files/') else path.lstrip('/')
                if path.startswith('/roots/'):
                    match = re.fullmatch(r'/roots/([A-Za-z0-9_-]+)/files/(.*)', path)
                    if not match:
                        raise PermissionError('Invalid root file URL')
                    root_id, relative = match.groups()
                self.serve_file(relative, head, root_id)
        except FileNotFoundError:
            self.json_response({'error': '파일이 없습니다. 목록을 새로고침하세요.'}, head, 404)
        except PermissionError:
            self.json_response({'error': '등록한 루트 안의 읽을 수 있는 파일만 열 수 있습니다.'}, head, 403)
        except NotADirectoryError:
            self.json_response({'error': '폴더가 아닙니다'}, head, 400)
        except (ValueError, UnicodeError, RuntimeError):
            self.json_response({'error': '올바르지 않은 경로입니다'}, head, 400)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OSError:
            self.json_response({'error': '파일을 읽을 수 없습니다'}, head, 500)

    def serve_file(self, relative, head, root_id='project'):
        path = self.server.resolve_path(relative, root_id)
        if path.is_dir():
            if (path / 'index.html').is_file():
                path = self.server.resolve_path((Path(relative) / 'index.html').as_posix(), root_id)
                # A trailing slash is needed for relative assets of directory index pages.
                if not urlsplit(self.path).path.endswith('/'):
                    self.respond(302, b'', 'text/plain', head,
                                 {'Location': urlsplit(self.path).path + '/'})
                    return
            else:
                self.respond(302, b'', 'text/plain', head,
                             {'Location': '/?' + 'root=' + quote(root_id, safe='') + '&path=' + quote(relative, safe='')})
                return
        if not path.is_file():
            raise PermissionError('Not a regular file')
        self.stream_file(path, head, document=True)

    def stream_file(self, path, head, document=False):
        with path.open('rb') as file:
            info = os.fstat(file.fileno())
            size, start, end, status = info.st_size, 0, info.st_size - 1, 200
            requested = self.headers.get('Range')
            if requested:
                match = re.fullmatch(r'bytes=(\d*)-(\d*)', requested.strip())
                if not match or not any(match.groups()) or size == 0:
                    self.respond(416, b'', 'text/plain', head, {'Content-Range': f'bytes */{size}'})
                    return
                first, last = match.groups()
                if first:
                    start = int(first)
                    end = min(int(last), size - 1) if last else size - 1
                else:
                    start = max(0, size - int(last))
                if start > end or start >= size:
                    self.respond(416, b'', 'text/plain', head, {'Content-Range': f'bytes */{size}'})
                    return
                status = 206
            mime = mimetypes.guess_type(str(path))[0] or 'application/octet-stream'
            if mime.startswith('text/'):
                mime += '; charset=utf-8'
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(max(0, end - start + 1)))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            if document and mime.split(';')[0] in {'text/html', 'application/xhtml+xml', 'image/svg+xml'}:
                # User documents must not drive the parent UI or change root configuration.
                # Static relative images/CSS still work; trusted app/PDF.js assets are separate.
                self.send_header('Content-Security-Policy', "script-src 'none'; object-src 'none'; frame-src 'none'")
            self.send_header('Last-Modified', self.date_time_string(info.st_mtime))
            if status == 206:
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.end_headers()
            if not head:
                file.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    block = file.read(min(256 * 1024, remaining))
                    if not block:
                        break
                    self.wfile.write(block)
                    remaining -= len(block)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--root', type=Path, default=Path.cwd(), help='Project directory (default: current directory)')
    parser.add_argument('--host', default='127.0.0.1', help='Listen address (default: 127.0.0.1)')
    parser.add_argument('--port', type=int, default=8765, help='HTTP port (default: 8765)')
    parser.add_argument('--show-hidden', action='store_true', help='Show hidden files, excluding .git and cache directories')
    parser.add_argument('--no-pdfjs', action='store_true', help='Use browser native PDF viewer; skip viewer asset download')
    parser.add_argument('--state-file', type=Path, help='Write bound port and instance metadata for the Bash launcher')
    args = parser.parse_args()
    if not args.root.is_dir():
        parser.error('--root must be an existing directory')
    pdfjs_root = None
    if not args.no_pdfjs:
        try:
            pdfjs_root = prepare_pdfjs()
        except (OSError, ValueError, zipfile.BadZipFile) as error:
            print(f'PDF.js unavailable: {error}. Falling back to native PDF viewer.', flush=True)
    try:
        server = FileBrowserServer((args.host, args.port), args.root, args.show_hidden, pdfjs_root)
    except OSError as error:
        parser.exit(1, f'Cannot start server: {error}\n')
    url = f'http://{args.host}:{server.server_port}/'
    if args.state_file:
        metadata = {'root': str(server.root), 'url': url, 'pid': os.getpid(),
                    'port': server.server_port, 'instance_id': server.instance_id}
        args.state_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.state_file.with_name(args.state_file.name + f'.{os.getpid()}.tmp')
        try:
            temporary.write_text(json.dumps(metadata, ensure_ascii=False), encoding='utf-8')
            temporary.replace(args.state_file)
        finally:
            temporary.unlink(missing_ok=True)
    print(f'Project: {server.root}\nOpen in Orca browser: {url}\n'
          'Read-only. Ctrl+C to stop.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()

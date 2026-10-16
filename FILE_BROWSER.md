> 설치·업데이트와 여러 루트 폴더 관리의 최신 안내는 [README.md](README.md)를 참고하세요.

# 프로젝트 파일 탐색기

`file_browser.py` 하나에 Python 서버와 탐색기 화면이 들어 있습니다.
Python 3.10 이상에서 실행하며 pip/npm 패키지를 설치할 필요는 없습니다.
PDF 미리보기는 Mozilla PDF.js를 사용합니다. 최초 실행 때 약 6MB의 공식 배포본을
다운로드하고 SHA-256을 확인해 사용자 캐시에 저장합니다. 이후에는 오프라인으로 실행할 수 있습니다.

## 간편 실행 (권장)

Linux 서버에 `python3`(3.10 이상), `tmux`, `flock`이 필요합니다.
이 폴더에서 한 번 설치합니다. 관리자 권한은 필요 없습니다.

```bash
bash file-browser.sh install
```

설치 후에는 **각 프로젝트 폴더에서 `fbrowse`**만 실행합니다.

```bash
cd /path/to/project
fbrowse
```

Orca 터미널에서는 **fbrowse** 이름의 Browser 탭이 자동으로 열리고, 기존 탭이 있으면
선택한 문서를 유지한 채 그 탭으로 전환합니다. `fbrowse --no-open`은 주소만 표시합니다.
포트는 운영체제가 빈 번호를 직접 배정합니다. 같은 프로젝트에서 다시 실행하면
기존 tmux 세션과 주소를 재사용하며, 다른 프로젝트는 별도 세션과 포트를 사용합니다.
심볼릭 링크로 접근해도 실제 경로가 같으면 같은 프로젝트입니다.

```bash
fbrowse /path/to/another-project  # 다른 프로젝트 시작
fbrowse url                      # 현재 프로젝트 주소만 표시
fbrowse list                     # 실행 중인 전체 프로젝트와 주소
fbrowse attach                   # 현재 프로젝트의 tmux 화면 열기
# Ctrl+B를 누른 뒤 D: tmux에서 나와도 서버는 계속 실행
fbrowse logs                     # 최근 서버 로그
fbrowse stop                     # 현재 프로젝트만 종료
fbrowse restart                  # 현재 프로젝트 재시작, 확인된 기존 포트 유지
```

`url`, `attach`, `logs`, `stop`, `restart` 뒤에도 프로젝트 경로를 지정할 수 있습니다.
세션 이름이나 포트 번호를 직접 기억할 필요는 없습니다. 세션은 내부적으로 폴더 이름과
경로 식별자를 조합해 생성하므로 이름이 같은 프로젝트끼리 충돌하지 않습니다.
기존 세션이 응답하지 않으면 임의로 중복 서버를 만들지 않고 `logs`/`restart`를 안내합니다.
서버를 종료한 뒤 다시 시작하면 주소가 달라질 수 있으므로 `fbrowse`로 현재 주소를 확인하세요.

Orca나 터미널 연결을 종료해도 tmux 서버가 실행 중인 동안 유지됩니다.
서버 재부팅 후에는 프로젝트 폴더에서 `fbrowse`를 다시 실행합니다.
설치 후 명령을 못 찾으면 아래 PATH 설정을 사용하고 `~/.bashrc`에도 추가합니다.

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### 다른 Linux 서버에 가져가기

독립 fbrowse 저장소 전체를 clone하거나 배포 압축을 풀고,
그 서버에서 `bash file-browser.sh install`을 한 번 실행합니다.
이후에는 어느 프로젝트에서든 `fbrowse`를 쓸 수 있습니다.
PDF.js는 각 서버에서 최초 실행할 때 한 번 준비합니다.
설치하지 않고 `bash /path/to/file-browser.sh`로 직접 실행해도 됩니다.

설치 위치는 `${XDG_DATA_HOME:-~/.local/share}/project-file-browser`,
실행 명령은 `~/.local/bin/fbrowse`, 프로젝트별 상태·로그는
`${XDG_STATE_HOME:-~/.local/state}/project-file-browser`에 저장합니다.
파일을 수정한 뒤 같은 설치 명령을 다시 실행하면 설치본이 갱신됩니다.
실행 중인 서버에 변경을 적용하려면 `fbrowse restart`를 실행합니다.

### Orca에서 화질이 다를 때

Orca 1.4.227 소스상 Ports의 Remote Server 열기는 서버에서 페이지를 렌더링한 후
화면을 전송하는 경로를 사용합니다. 이 전송에는 이미지 품질·최대 크기 제한이 있습니다.
터미널 URL의 **Orca Browser** 열기는 브라우저 배치 선택을 거치므로,
클라이언트에서 직접 렌더링할 수 있는 환경에서는 더 선명할 수 있습니다.
클라이언트 렌더링에서도 네트워크 요청은 원격 서버를 경유합니다.
이는 PDF 파일 자체의 품질이나 Python 서버의 파일 용량 제한과는 별개입니다.

따라서 지금 환경에서는 `fbrowse`가 출력한 **터미널 링크 → Orca Browser**로 여는 방식을 권장합니다.
Ports로 연 기존 탭의 표시 방식을 이 실행기가 바꾸지는 않습니다.

근거: [Ports 열기](https://github.com/stablyai/orca/blob/v1.4.227/src/renderer/src/lib/workspace-port-actions.ts),
[URL 열기 경로](https://github.com/stablyai/orca/blob/v1.4.227/src/renderer/src/lib/workspace-browser-tab-open.ts),
[전송 품질 제한](https://github.com/stablyai/orca/blob/v1.4.227/src/main/browser/browser-screencast-frame-budget.ts).

## Python으로 직접 실행

```bash
python3 file_browser.py --root /path/to/project --port 8765
```

Orca의 해당 서버 워크스페이스에서 브라우저를 열고 다음 주소를 입력합니다.

```text
http://127.0.0.1:8765/
```

`orca serve` 구성에서는 서버의 localhost입니다. PC의 외부 Chrome에서 같은 주소를
입력하는 것만으로는 연결되지 않습니다.

이미 같은 포트에서 `python3 -m http.server`를 실행 중이라면 해당 터미널에서
Ctrl+C로 종료한 다음 이 서버를 실행합니다. 새 서버도 Ctrl+C로 종료합니다.

다른 프로젝트는 같은 스크립트에 다른 `--root`를 지정하면 됩니다.
동시에 여러 서버를 실행한다면 각각 다른 `--port`를 사용하거나,
위 Bash 실행기로 포트를 자동 배정합니다.

## 사용

- 왼쪽 폴더 이름을 누르면 하위 폴더와 파일이 펼쳐집니다.
- 왼쪽 목록과 문서 사이의 경계선은 전체 높이에서 드래그해 너비를 조절합니다.
  PDF 위로 마우스를 옮겨도 조절이 이어지고, 너비는 같은 브라우저 주소에서 기억합니다.
  경계선을 Tab으로 선택하면 좌우 방향키로도 조절할 수 있습니다.
- 검색창, 파일 형식 필터, 새로고침과 문서 도구는 왼쪽 패널에 모았습니다.
  오른쪽에는 중복 파일명·경로·하단 안내문 없이 미리보기만 표시합니다.
- 검색창은 프로젝트 전체의 파일명과 상대 경로를 검색합니다. 여러 단어는 모두 포함되어야 합니다.
- PDF/HTML 필터는 폴더 목록과 검색 결과 모두에 적용됩니다.
- **Markdown / 코드** 필터도 폴더 목록과 검색 결과 모두에서 사용할 수 있습니다.
- 파일을 누르면 오른쪽에 표시됩니다. PDF에서는 페이지 이동, 확대, 본문 검색을 사용할 수 있습니다.
- Python, JavaScript/TypeScript, Shell, JSON, YAML, C/C++, LaTeX 등 코드 파일은
  문법 색상을 표시하며 긴 줄은 기본적으로 화면 너비에 맞춰 자동 줄바꿈합니다.
  자동 줄바꿈을 켜도 원본 줄 번호를 유지하며, 접힌 줄의 높이에 맞춰 번호를 정렬합니다.
  자동 줄바꿈을 끄면 가로 스크롤로 볼 수 있습니다. 전체 원문 복사도 지원합니다.
- Markdown은 제목·목록·표·링크·이미지·코드 블록을 서식에 맞게 표시하며,
  **원문 보기 / 미리보기**로 전환합니다. 상대 경로 이미지와 문서 링크도 지원합니다.
  문서에 포함된 스크립트와 이벤트 핸들러는 미리보기에서 제거합니다.
- 왼쪽 파일 형식 필터 옆의 **⛶ 크게 보기**를 누르면 폴더와 검색창을 가리고 미리보기를 크게 봅니다.
  Orca 자체의 탭과 사이드바는 유지합니다. 왼쪽 아래 **기본 보기** 또는 **Esc**로 원래 화면으로 돌아옵니다.
  PDF는 기본적으로 화면 너비에 맞춰 표시합니다.
- HTML은 실제 파일 URL로 표시하므로 상대 경로의 CSS, 이미지, JavaScript도 읽을 수 있습니다.
- 새로고침은 파일 목록, 검색 색인, 현재 미리보기를 갱신합니다.
- 링크 복사로 선택한 파일을 다시 여는 주소를 얻을 수 있습니다.
- Ctrl+K / Cmd+K 또는 `/`로 검색창에 이동합니다. 검색창에서 Esc를 누르면 검색을 지웁니다.

파일명 검색과 PDF 본문 검색은 별개입니다. PDF 본문은 PDF 뷰어 안에서 검색합니다.
HTML이 외부 서비스나 별도 앱 서버를 요구하는 경우 그 환경까지 대신 실행하지는 않습니다.

## 파일과 설정

읽기 전용이며 업로드, 수정, 삭제 API는 없습니다. 지정한 프로젝트 밖의 파일과
밖을 가리키는 심볼릭 링크는 제공하지 않습니다. 숨김 파일, `.git`, 가상환경,
`node_modules`, 캐시 디렉터리는 기본적으로 표시하지 않습니다.

```bash
python3 file_browser.py --help
python3 file_browser.py --root . --show-hidden
python3 file_browser.py --root . --no-pdfjs
```

`--no-pdfjs`는 PDF.js 준비를 건너뛰고 브라우저 내장 PDF 뷰어를 사용합니다.
PDF.js 캐시 위치는 `${XDG_CACHE_HOME:-~/.cache}/project-file-browser/pdfjs-6.4.299`입니다.
텍스트 뷰어는 highlight.js, Marked, DOMPurify의 버전과 SHA-256을 고정해 사용합니다.
최초 코드/Markdown 열기 때 약 210KB의 구성 요소를 서버에서 내려받아
`${XDG_CACHE_HOME:-~/.cache}/project-file-browser/text-assets`에 캐시합니다.
그다음부터는 오프라인으로 작동합니다. 준비에 실패해도 원문은 볼 수 있습니다.
텍스트는 UTF-8과 BOM이 있는 UTF-16/UTF-32를 지원하며, 바이너리는 원본 링크로 엽니다.
30만 자를 넘는 텍스트 파일은 전체 원문을 표시하고 문법 강조와 Markdown 서식은 생략합니다.
기본 접속 주소는 서버의 `127.0.0.1`이며, 인증 없이 같은 서버에서만 접근하는 용도입니다.

## 검증

```bash
python3 -B -m unittest -v test_file_browser.py test_file_browser_launcher.py
```

3MiB보다 큰 파일의 전체 전송, HTTP Range, 한글·공백·특수문자 경로,
하위 폴더 검색, HTML 상대 리소스, 경로 접근 범위를 검사합니다.
실제 tmux로 동시 실행·주소 재사용·프로젝트별 포트 분리·개별 종료·
특수문자 경로·서버 식별 검증·설치본 실행도 검사합니다.
코드/Markdown 분류와 검색 필터, 텍스트 인코딩, 바이너리 처리,
3MiB를 넘는 코드의 전체 읽기도 검사합니다.

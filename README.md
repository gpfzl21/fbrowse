# fbrowse

Linux 서버에서 한 번 설치하고 어느 프로젝트에서나 실행하는 파일 탐색기입니다.
프로젝트 파일과 `/mnt` 등에 있는 다른 폴더를 한 창에서 전환하고 오른쪽에서
PDF, HTML, Markdown, 코드, 이미지 등을 미리 봅니다. 파일은 읽기 전용입니다.

## 설치와 실행

필요 환경: Linux, Bash, Python 3.10 이상, tmux, flock. pip/npm 설치는 필요 없습니다.
이 저장소를 clone하거나 배포 압축을 풀어 다음을 실행합니다.

```bash
bash file-browser.sh install
export PATH="$HOME/.local/bin:$PATH"  # 필요하면 셸 설정 파일에도 추가
cd /path/to/any/project
fbrowse
```

표시된 HTTP 주소를 서버에 연결된 Orca Browser에서 엽니다. 프로젝트에는 앱이나
설정 파일이 생성되지 않습니다. 서버별·Linux 사용자별 한 번 설치하면 됩니다.
다른 PC의 Chrome에서 서버의 `127.0.0.1` 주소로 바로 접속할 수 있는 것은 아닙니다.
외부 PC 접속에는 별도로 구성한 터널이 필요합니다.

## 여러 루트 폴더

왼쪽의 **루트 관리 → 폴더 찾아 연결**에서 서버의 디렉터리를 보며 선택합니다.
프로젝트·홈·`/mnt`·`/media` 바로가기, 상위 폴더, 경로 탐색줄, 직접 경로 이동,
이름 필터와 숨김 표시를 제공합니다. 폴더 안의 파일 이름도 참고용으로 표시합니다.
**이 폴더 연결**을 누르면 이름과 경로를 저장하고 바로 해당 루트로 전환합니다.
직접 입력은 **경로 직접 입력**을 펼쳐서 사용하며, 등록한 이름·경로 수정과 연결 제거도 가능합니다.
**루트 폴더 선택**으로 빠르게 전환합니다. 기본 `project` 루트는 실행한
현재 디렉터리이며 고정되어 있습니다. 마지막 선택은 브라우저에 기억됩니다.

예: 프로젝트 `/home/user/project`, 논문 `/mnt/data/papers`, 실험결과 `/mnt/archive/results`.
해당 서버에 이미 존재하는 디렉터리만 새로 등록할 수 있습니다. 앱은 디스크를
마운트하거나 데이터를 업로드·이동·삭제·동기화하지 않습니다.
연결 후 경로가 사라지면 **연결 안 됨**으로 표시하며 다른 루트는 계속 동작합니다.
일반 디렉터리로 남아 있는 빈 마운트 지점의 마운트 여부는 자동 판별하지 않습니다.

명령으로도 설정할 수 있습니다.

```bash
fbrowse roots add papers /mnt/data/papers --name 논문
fbrowse roots add results /mnt/archive/results --name 실험결과
fbrowse roots edit papers /mnt/new/papers --name 참고논문
fbrowse roots list
fbrowse roots remove papers
fbrowse roots list --project /path/to/other/project
```

등록 설정은 프로젝트별로 `$XDG_CONFIG_HOME/fbrowse/projects/<프로젝트 경로 해시>.json`
(기본 `~/.config/fbrowse/...`)에 저장합니다. 이름은 한글과 공백을 지원하며 ID는
안정적으로 유지됩니다. 서버 경로와 ID는 검색 결과·링크·미리보기에서 구분됩니다.
검색은 선택한 루트의 하위 폴더를 대상으로 합니다. 연결 변경은 새로고침으로 반영됩니다.
폴더 선택기는 명시적으로 연 한 단계의 항목 이름만 조회합니다. 탐색하거나 취소하는
것만으로 루트가 등록되거나 해당 위치의 파일 미리보기 권한이 생기지 않습니다.
선택한 루트 밖의 심볼릭 링크와 상위 경로 접근은 차단하고 숨김 파일은 기본 제외합니다.
HTML/SVG는 정적 문서로 표시하며 문서 스크립트와 내장 프레임 실행은 차단합니다.
상대 경로의 이미지와 CSS는 그대로 표시합니다.

## 서버 관리

```bash
fbrowse /path/to/project
fbrowse url                    # 현재 프로젝트 주소
fbrowse list                   # 실행 중인 프로젝트
fbrowse logs
fbrowse attach                 # Ctrl+B, D로 분리
fbrowse restart                # 소유권이 확인된 기존 서버의 포트 유지
fbrowse stop                   # 현재 프로젝트만 종료
fbrowse --version
fbrowse --no-pdfjs              # 뷰어 다운로드 없이 시작
```

같은 프로젝트는 서버를 재사용하고 다른 프로젝트는 별도 세션과 포트를 사용합니다.
PDF.js와 코드/Markdown 구성 요소는 최초 사용 시 네트워크로 다운로드하여 검증하고
`$XDG_CACHE_HOME/project-file-browser`에 캐시합니다. 캐시가 준비되면 오프라인 사용이
가능합니다. PDF.js 준비 실패 시 브라우저 기본 PDF 뷰어를 사용합니다.

## 업데이트와 제거

새 버전의 저장소/압축을 받은 뒤 실행합니다. 앱이 GitHub 저장소를 임의로 선택하거나
네트워크에서 코드를 자동 실행하지 않습니다.

```bash
bash /path/to/new/source/file-browser.sh install
# 또는 이미 설치된 명령으로:
fbrowse update /path/to/new/source
fbrowse restart /path/to/project
fbrowse uninstall
```

설치는 `$XDG_DATA_HOME/project-file-browser/releases` 아래에 버전별로 보관하고 실행
링크를 원자적으로 전환합니다. 이전 설치 파일은 최초 전환 시 `legacy-backup`에 보관합니다.
진행 중인 서버는 업데이트로 종료하지 않습니다. 재시작하면 현재 설치 버전이 적용됩니다.
기존의 무관한 `~/.local/bin/fbrowse` 명령은 덮어쓰지 않습니다.

제거 명령은 본 앱의 명령 링크만 제거합니다. 실행 중인 서버와 설치 버전, XDG 설정·상태·캐시는
유지합니다. 다시 설치하면 재사용할 수 있습니다. 설치 버전은 실행 중인 서버가 있으므로
자동 정리하지 않습니다. 완전 삭제가 필요하면 모든 fbrowse 서버 종료 후 해당 전용
디렉터리만 직접 정리하세요.

## 검증과 배포 상태

```bash
python3 -B -m unittest -v test_file_browser.py test_file_browser_launcher.py
```

HTTP/Range, 경로 경계, 다중 루트, CLI 설치·업데이트와 실제 tmux 세션을 검증합니다.
테스트는 임시 프로젝트와 임시 HOME/XDG를 사용합니다. 앱 실행에는 테스트 도구가 필요 없습니다.
Node와 Playwright가 있는 개발 환경에서는 다음으로 브라우저 동작도 확인합니다.

```bash
node test_browser.cjs /path/to/playwright
python3 -B build_release.py   # dist/fbrowse-0.1.0.tar.gz 및 SHA-256
```

배포 압축은 명시한 앱·문서·테스트 파일만 포함하며 사용자 설정이나 프로젝트 데이터는
포함하지 않습니다.
상세 뷰어 기능은 [FILE_BROWSER.md](FILE_BROWSER.md)를 참고하세요.

현재 버전: `0.1.0`. GitHub 게시 대상·공개 범위·배포 라이선스는 소유자가 결정한 뒤
게시합니다. 라이선스 상태는 [LICENSE.md](LICENSE.md), 외부 구성 요소는
[THIRD_PARTY.md](THIRD_PARTY.md)를 참고하세요.

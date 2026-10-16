# fbrowse

Linux 서버의 프로젝트 파일과 선택한 디스크 폴더를 한 창에서 탐색하는 읽기 전용 파일 브라우저입니다.
**Node.js 22 이상**에서 실행합니다. Python, Bash 실행기, tmux, flock은 필요하지 않습니다.

## 설치

배포된 npm 압축을 받은 뒤 서버의 사용자 계정에 한 번 설치합니다.

```bash
npm install --global ./fbrowse-cli-0.2.0.tgz
cd /path/to/project
fbrowse
```

프로젝트마다 앱을 복사하거나 `npm install`을 실행할 필요가 없습니다. 실행할 때의 현재 디렉터리가
기본 프로젝트 루트가 됩니다. 앱과 설정 파일을 프로젝트 안에 생성하지 않습니다.
현재 npm registry에는 게시하지 않았습니다. `@fbrowse/cli`는 로컬 패키지 이름이며, 공개 배포 대상과
라이선스를 결정하기 전까지 `private: true`로 게시를 막아두었습니다.

소스에서 설치용 압축을 만드는 경우:

```bash
npm install
mkdir -p dist
npm pack --pack-destination dist
npm install --global ./dist/fbrowse-cli-0.2.0.tgz
```

npm 전역 경로를 사용자 디렉터리로 지정할 수도 있습니다.

```bash
npm install --global --prefix "$HOME/.local" ./fbrowse-cli-0.2.0.tgz
export PATH="$HOME/.local/bin:$PATH"
```

기존에 다른 `fbrowse` 명령이 있으면 먼저 소유권과 위치를 확인하세요. 무관한 명령에 `--force`로
덮어쓰지 마세요.

## 실행과 종료

```bash
fbrowse                        # 현재 프로젝트에서 시작하거나 기존 서버 재사용
fbrowse /path/to/project        # 다른 프로젝트 시작
fbrowse url                    # 현재 프로젝트의 HTTP 주소
fbrowse list                   # 실행 중인 Node 서버 목록
fbrowse logs                   # 현재 프로젝트의 최근 로그
fbrowse stop                   # 현재 프로젝트만 종료
fbrowse restart                # 확인된 기존 포트를 유지하여 재시작
fbrowse --no-pdfjs              # PDF.js 준비 없이 시작
fbrowse --version
fbrowse help
```

서버는 터미널과 분리된 Node 프로세스로 실행합니다. tmux에 접속하거나 터미널을 계속 열어둘 필요가
없습니다. 재부팅 시 자동으로 시작하는 서비스는 설치하지 않습니다. 같은 프로젝트에서는 서버를
재사용하고 다른 프로젝트는 별도 포트로 실행합니다. 종료는 루트·인스턴스 식별과 인증된 HTTP 요청으로
처리하며, 상태 파일에 적힌 PID만 믿고 다른 프로세스를 종료하지 않습니다.

**브라우저 자동 열기는 하지 않습니다.** 표시된 HTTP 주소를 Orca Browser에서 직접 엽니다.
Orca는 선택한 브라우저 환경이며 앱의 런타임 의존성은 아닙니다. 원격 Linux 서버의 `127.0.0.1`은
Windows PC의 localhost와 다릅니다. 외부 Chrome으로 접속하려면 별도의 연결 경로가 필요합니다.

## 여러 루트 폴더 연결

왼쪽 **루트 관리 → 폴더 찾아 연결…**에서 서버의 폴더를 보며 선택합니다.

- 프로젝트·홈·`/mnt`·`/media` 바로가기, 상위 폴더, 경로 탐색줄과 직접 경로 이동
- 내부 폴더와 참고용 파일 이름, 이름 필터와 숨김 표시
- **이 폴더 연결**로 이름·경로 저장 후 해당 루트로 전환
- 등록한 이름·경로 수정, 연결 제거, 끊긴 경로 표시

예를 들어 프로젝트 `/home/user/project`, 논문 `/mnt/data/papers`, 실험결과 `/mnt/archive/results`를
연결할 수 있습니다. 서버에 이미 존재하는 폴더만 새로 연결할 수 있으며 마운트 작업이나 파일
이동·삭제·업로드·동기화는 수행하지 않습니다. 경로가 사라지면 연결 안 됨으로 표시합니다.
디렉터리로 남아 있는 빈 마운트 지점의 마운트 여부까지 자동 판별하지는 않습니다.

```bash
fbrowse roots add papers /mnt/data/papers --name 논문
fbrowse roots edit papers /mnt/new/papers --name 참고논문
fbrowse roots list
fbrowse roots remove papers
fbrowse roots list --project /path/to/other/project
```

등록 정보는 프로젝트별로 `$XDG_CONFIG_HOME/fbrowse/projects/<경로 해시>.json`
(기본 `~/.config/fbrowse/...`)에 기억됩니다. 기존 Python 버전과 설정 형식·위치를 공유합니다.
검색과 미리보기 링크에 root ID와 상대 경로를 사용하므로 같은 이름의 파일도 구분됩니다.
검색은 선택한 루트의 하위 폴더를 대상으로 합니다. 폴더 선택기로 둘러보는 것만으로는 루트가
등록되거나 해당 위치의 파일 내용에 접근할 수 있게 되지 않습니다.

## 미리보기

PDF.js의 페이지 너비 보기와 큰 PDF의 HTTP Range 스트리밍, HTML의 상대 이미지·CSS,
코드 문법 색상, Markdown 렌더링·원문 전환을 지원합니다. Markdown 출력은 정제하고
사용자 HTML/SVG의 스크립트·내장 프레임은 차단합니다. 선택한 루트 밖의 심볼릭 링크와
상위 경로 접근을 차단하며 숨김 파일은 기본으로 제외합니다.

자동 줄바꿈은 기본 켜짐입니다. 접힌 긴 줄에도 원래 논리 줄번호를 유지하며, 30만 자를 넘는
텍스트는 문법 색상·Markdown 서식 없이 원문으로 표시하고 2만 논리 줄을 넘으면 줄번호를 생략합니다.
세로 분할선으로 목록 너비를 조절하고 크게 보기는 웹 페이지 안에서만 동작합니다. Escape로 복귀합니다.

PDF.js와 코드/Markdown 구성 요소는 고정 버전과 SHA-256 검증을 거쳐
`$XDG_CACHE_HOME/project-file-browser`에 캐시합니다. 최초 준비에는 네트워크가 필요하고,
캐시가 준비되면 오프라인으로 사용할 수 있습니다. 기존 코드/Markdown 캐시는 재사용합니다.
Python 버전의 PDF.js 캐시에 파일별 검증 정보가 없으면 Node 전용 `pdfjs-6.4.299-node`에
한 번 새로 준비합니다. 실행 중인 기존 뷰어의 캐시는 덮어쓰지 않습니다.
PDF.js 준비가 실패하면 브라우저 기본 PDF 뷰어로 전환합니다.

## 업데이트와 제거

```bash
npm install --global ./새버전의-fbrowse-cli.tgz
fbrowse restart /path/to/project
npm uninstall --global @fbrowse/cli
```

`--prefix`로 설치했다면 업데이트·제거 때도 같은 prefix를 지정합니다. 업데이트 자체는 실행 중인
서버를 종료하지 않습니다. 새 코드를 적용할 프로젝트만 명시적으로 재시작하세요.
제거 전에 필요한 프로젝트의 `fbrowse stop`을 실행하세요. npm 제거는 실행 중인 서버를 강제로
종료하거나 XDG 설정·상태·캐시 및 프로젝트 데이터를 삭제하는 명령이 아닙니다.

Node 실행 상태와 로그는 `$XDG_STATE_HOME/fbrowse/<경로 해시>/`에 저장합니다.
이전 Python 버전의 상태 위치와 분리되어 있으며 Node 명령은 tmux 세션을 조작하지 않습니다.

## 개발과 검증

```bash
npm ci
npm test
npm run pack:check
FBROWSE_PLAYWRIGHT_MODULE=/path/to/playwright npm run test:browser
```

테스트는 임시 HOME/XDG/프로젝트를 사용합니다. 패키지 검증은 실제 npm 압축을 임시 전역 경로에 설치하고,
PATH에 Node만 남긴 환경에서 실행하여 Python·Bash·tmux·flock 없이 동작하는지 확인합니다.
Playwright와 Chromium은 선택적 개발 도구이며 앱 실행에는 필요하지 않습니다.

배포 라이선스는 [LICENSE.md](LICENSE.md), 외부 구성 요소는 [THIRD_PARTY.md](THIRD_PARTY.md)를 참고하세요.

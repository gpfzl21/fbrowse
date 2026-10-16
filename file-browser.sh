#!/usr/bin/env bash
# Project file browser: one tmux session per canonical project directory.
set -euo pipefail
umask 077

die() { printf 'fbrowse: %s\n' "$*" >&2; exit 1; }
usage() {
    cat <<'HELP'
Usage: fbrowse [start|url|attach|logs|stop|restart] [PROJECT] [--no-pdfjs]
       fbrowse list
       fbrowse roots [list|add|edit|remove] [ID] [PATH] [--name NAME] [--project DIR]
       bash file-browser.sh install

  fbrowse               현재 폴더에서 시작, 실행 중이면 기존 주소 표시
  fbrowse /path/project 다른 프로젝트 시작 (빈 포트 자동 배정)
  fbrowse url           현재 프로젝트 주소만 출력
  fbrowse attach        현재 프로젝트의 tmux 화면 (Ctrl+B, D로 나오기)
  fbrowse logs          최근 서버 로그
  fbrowse list          실행 중인 프로젝트와 주소
  fbrowse stop          현재 프로젝트 서버 종료
  fbrowse restart       현재 프로젝트 재시작 (확인된 기존 포트 유지)
  fbrowse roots         현재 프로젝트의 등록된 루트 목록
  fbrowse roots add papers /mnt/data/papers --name 논문
  fbrowse roots edit papers /mnt/archive/papers --name 논문
  fbrowse roots remove papers
  fbrowse update SOURCE 새 소스 디렉터리에서 설치 버전 갱신
  fbrowse uninstall     명령 링크 제거 (서버·설정·설치 버전 보존)
  fbrowse version       앱 버전
  fbrowse help          이 도움말

Linux: Bash, Python 3.10+, tmux, flock 필요. 최초 PDF 뷰어 준비 시 인터넷 필요.
HELP
}
command -v python3 >/dev/null || die 'Python 3.10 이상이 필요합니다.'
python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' || die 'Python 3.10 이상이 필요합니다.'
script_path=$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve())' "${BASH_SOURCE[0]}")
script_dir=${script_path%/*}
server_script=$script_dir/file_browser.py
state_base=${XDG_STATE_HOME:-$HOME/.local/state}/project-file-browser
action=start
case "${1:-}" in
    start|url|attach|logs|stop|restart|list|install|update|uninstall|version|roots|help) action=$1; shift ;;
    --version) action=version; shift ;;
    -h|--help) usage; exit 0 ;;
esac
if [[ $action == help ]]; then usage; exit 0; fi
case "$action" in
    install|update|uninstall|version|roots) exec python3 -B "$script_dir/fbrowse_admin.py" "$action" "$@" ;;
esac
for dependency in tmux flock; do
    command -v "$dependency" >/dev/null || die "필요한 명령이 없습니다: $dependency"
done

# Keep lock fd out of tmux clients/the server so background sessions never hold it.
tm() {
    local argument
    local -a arguments=()
    # tmux parses a trailing semicolon as its own command separator, even in argv.
    for argument in "$@"; do
        [[ $argument != *';' ]] || argument="${argument%;}\\;"
        arguments+=("$argument")
    done
    command tmux "${arguments[@]}" 9>&-
}

# Validate identity through HTTP before reusing a recorded port (ports can be recycled).
healthy_url() {
    python3 - "$state_dir/server.json" "$root" <<'PY'
import json, sys, urllib.request
try:
    with open(sys.argv[1], encoding='utf-8') as stream:
        data = json.load(stream)
    port = data['port']
    if not isinstance(port, int) or not 0 < port < 65536:
        raise ValueError('invalid port')
    url = f'http://127.0.0.1:{port}/'
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url + 'api/info', timeout=1) as response:
        info = json.load(response)
    if (data['root'] == sys.argv[2] == info['root']
            and info.get('service') == 'project-file-browser'
            and data['instance_id'] == info['instance_id']):
        print(url)
        sys.exit(0)
except (OSError, ValueError, KeyError, TypeError):
    pass
sys.exit(1)
PY
}

if [[ $action == list ]]; then
    [[ $# == 0 ]] || die 'list에는 인수를 지정하지 마세요.'
    mkdir -p "$state_base"
    found=0
    for record in "$state_base"/*/server.json; do
        [[ -f $record ]] || continue
        state_dir=${record%/*}
        root=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["root"])' "$record" 2>/dev/null) || continue
        if url=$(healthy_url); then printf '%s  %s\n' "$url" "$root"; found=1; fi
    done
    [[ $found == 1 ]] || printf '실행 중인 파일 탐색기가 없습니다.\n'
    exit 0
fi

project=.
project_set=0
extra=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-pdfjs) extra+=(--no-pdfjs); shift ;;
        --) shift; [[ $# == 1 && $project_set == 0 ]] || die '프로젝트 경로 하나를 지정하세요.'
            project=$1; project_set=1; shift ;;
        -*) die "알 수 없는 옵션: $1 (fbrowse help 참고)" ;;
        *) [[ $project_set == 0 ]] || die '프로젝트 경로 하나만 지정하세요.'
            project=$1; project_set=1; shift ;;
    esac
done
root=$(python3 - "$project" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1]).resolve()
if not p.is_dir():
    sys.exit('프로젝트 폴더가 없습니다: ' + str(p))
print(p)
PY
) || exit 1
key=$(python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:16])' "$root")
label=$(python3 -c 'import re,sys; from pathlib import Path; print(re.sub("[^a-zA-Z0-9_-]+", "-", Path(sys.argv[1]).name).strip("-")[:24] or "project")' "$root")
session=files-$label-$key
state_dir=$state_base/$key
mkdir -p "$state_dir"
exec 9>"$state_dir/lock"
flock -w 15 9 || die '다른 실행기가 작업 중입니다. 잠시 후 다시 실행하세요.'

has_session() { tm has-session -t "=$session" 2>/dev/null; }
owned_session() {
    [[ $(tm show-options -qv -t "$session" @project_files_root) == "$root" ]]
}
stop_server() {
    if has_session; then
        owned_session || die "동일 이름의 다른 tmux 세션을 발견했습니다: $session"
        tm kill-session -t "=$session"
    fi
    rm -f -- "$state_dir/server.json"
}
desired_port=0
case "$action" in
    stop) stop_server; printf '종료: %s\n' "$root"; exit 0 ;;
    restart)
        if previous_url=$(healthy_url); then
            desired_port=${previous_url#http://127.0.0.1:}
            desired_port=${desired_port%/}
        fi
        stop_server
        if [[ $desired_port != 0 ]]; then
            python3 - "$desired_port" <<'PYWAIT'
import socket, sys, time
for attempt in range(100):
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            listener.bind(('127.0.0.1', int(sys.argv[1])))
            break
        except OSError:
            time.sleep(.05)
else:
    sys.exit('fbrowse: 기존 포트 종료를 기다리다 시간이 초과되었습니다.')
PYWAIT
        fi ;;
    logs) [[ -f $state_dir/server.log ]] || die '로그가 없습니다. fbrowse 로 먼저 실행하세요.'
        tail -n 60 -- "$state_dir/server.log"; exit 0 ;;
    attach)
        has_session && owned_session || die '실행 중인 세션이 없습니다. fbrowse 로 먼저 실행하세요.'
        flock -u 9
        exec 9>&-
        if [[ -n ${TMUX:-} ]]; then exec tmux switch-client -t "=$session"; fi
        exec tmux attach-session -t "=$session" ;;
esac

if has_session; then
    owned_session || die "동일 이름의 다른 tmux 세션을 발견했습니다: $session"
    if url=$(healthy_url); then
        if [[ $action == url ]]; then printf '%s\n' "$url"; else
            printf '실행 중: %s\n%s\n\n세션 보기: fbrowse attach\n전체 목록: fbrowse list\n' "$root" "$url"
        fi
        exit 0
    fi
    die '기존 세션이 응답하지 않습니다. fbrowse logs 로 확인하거나 fbrowse restart 로 재시작하세요.'
fi
[[ $action != url ]] || die '실행 중인 서버가 없습니다. fbrowse 로 먼저 실행하세요.'
[[ -f $server_script ]] || die "파일이 없습니다: $server_script"
rm -f -- "$state_dir/server.json"
python_bin=$(command -v python3)
{
    printf '#!/usr/bin/env bash\n'
    # tmux servers can retain another shell's HOME/XDG environment. Pin this caller's layout.
    printf 'exec env HOME=%q XDG_CONFIG_HOME=%q XDG_CACHE_HOME=%q XDG_DATA_HOME=%q XDG_STATE_HOME=%q ' \
        "$HOME" "${XDG_CONFIG_HOME:-$HOME/.config}" "${XDG_CACHE_HOME:-$HOME/.cache}" \
        "${XDG_DATA_HOME:-$HOME/.local/share}" "${XDG_STATE_HOME:-$HOME/.local/state}"
    printf '%q -u -B %q --root %q --port %q --state-file %q' \
        "$python_bin" "$server_script" "$root" "$desired_port" "$state_dir/server.json"
    if [[ ${#extra[@]} -gt 0 ]]; then printf ' %q' "${extra[@]}"; fi
    printf ' > >(tee -a %q) 2>&1\n' "$state_dir/server.log"
} > "$state_dir/run.sh"
# Multiple command arguments make tmux exec directly rather than interpolate paths.
tm new-session -d -s "$session" -c "$root" bash "$state_dir/run.sh"
tm set-option -t "$session" @project_files_root "$root"
printf '시작 중: %s\n' "$root"
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
    if url=$(healthy_url); then
        printf '\n%s\n\n세션 보기: fbrowse attach\n전체 목록: fbrowse list\n종료: fbrowse stop\n' "$url"
        exit 0
    fi
    if ! has_session; then
        tail -n 15 -- "$state_dir/server.log" >&2 || true
        die '서버 시작에 실패했습니다.'
    fi
    sleep 0.25
done
die '아직 준비 중입니다. fbrowse logs 로 확인하고 fbrowse 를 다시 실행하세요.'

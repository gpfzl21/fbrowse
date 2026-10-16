# 외부 뷰어 구성 요소

Python/Bash 런타임에는 pip/npm 패키지가 필요하지 않습니다. 다음 브라우저 구성 요소는
앱 최초 사용 시 고정 버전과 SHA-256 검증을 거쳐 XDG 캐시에 다운로드됩니다.
외부 구성 요소의 소스 코드와 배포 파일은 이 저장소에 포함하지 않습니다.

| 구성 요소 | 버전 | 라이선스 | upstream |
| --- | --- | --- | --- |
| PDF.js | 6.4.299 | Apache-2.0 | https://github.com/mozilla/pdf.js |
| highlight.js | 11.12.0 | BSD-3-Clause | https://github.com/highlightjs/highlight.js |
| Marked | 18.1.1 | MIT | https://github.com/markedjs/marked |
| DOMPurify | 3.4.17 | Apache-2.0 또는 MPL-2.0 | https://github.com/cure53/DOMPurify |

버전과 체크섬은 `file_browser.py`에 선언되어 있습니다. PDF.js 배포 압축의 라이선스
파일은 캐시에 함께 유지됩니다. 외부 구성 요소를 앱과 묶어서 배포하려면 해당
라이선스의 고지·재배포 조건도 충족해야 합니다.

# 외부 구성 요소

서버와 CLI는 Node.js 표준 모듈을 사용하며, PDF.js 배포 ZIP을 읽기 위해 npm 의존성
[`fflate` 0.8.3](https://github.com/101arrowz/fflate) (MIT)을 사용합니다. npm 설치가 함께 준비하며
추가 시스템 패키지나 Python 도구를 실행하지 않습니다.

다음 브라우저 구성 요소는 고정 버전과 SHA-256 검증을 거쳐 필요할 때 XDG 캐시에 다운로드합니다.
외부 뷰어 배포 파일을 이 저장소나 npm 패키지에 포함하지 않습니다.

| 구성 요소 | 버전 | 라이선스 | upstream |
| --- | --- | --- | --- |
| PDF.js | 6.4.299 | Apache-2.0 | https://github.com/mozilla/pdf.js |
| highlight.js | 11.12.0 | BSD-3-Clause | https://github.com/highlightjs/highlight.js |
| Marked | 18.1.1 | MIT | https://github.com/markedjs/marked |
| DOMPurify | 3.4.17 | Apache-2.0 또는 MPL-2.0 | https://github.com/cure53/DOMPurify |

버전과 체크섬은 `lib/assets.mjs`에 선언되어 있습니다. PDF.js 배포본의 라이선스 파일은
캐시에 함께 유지합니다. 외부 구성 요소를 별도 묶음으로 재배포할 때는 해당 라이선스의
고지·재배포 조건을 충족해야 합니다.

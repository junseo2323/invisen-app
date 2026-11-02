# invisen 작업자 앱

현장 작업자용 미세먼지 노출 모니터링 앱. 웹앱(Vite + TypeScript)을 iOS WKWebView(Capacitor 8)로 감싸 배포합니다.

- 디자인 원본: `design/*.dc.html` (Design 캔버스 "invisen 작업자 앱", 14개 화면), 토큰 `design/tokens.json`
- 화면 마크업: `src/screens/markup/*.html` — `npm run design:import`가 디자인 파일에서 그대로 생성(빌드 때 자동 실행)
- 화면 상태 로직: `src/screens/logic.ts` (디자인의 `renderVals()`를 옮긴 것)
- 렌더러: `src/dc.ts` — `{{hole}}`, `<sc-for>`, `<sc-if>`, `on*` 핸들러 지원, 상태 변경 시 DOM을 제자리 패치

## 화면 / 라우트

| 라우트 | 화면 |
|---|---|
| `#/main` | 01 시작 |
| `#/login-phone` · `#/login-profile` · `#/login-sensor` · `#/login-wear` | 02–05 로그인 플로우 |
| `#/home` | 06 홈 · 안전 |
| `#/site` · `#/sensor` · `#/exposure` · `#/log` · `#/more` | 07–11 현장 / 센서값 / 노출량 / 기록 / 전체 |
| `#/home-caution` · `#/alert-danger` · `#/sos` | 12–14 상태 변화 · 긴급 |

로그인 플로우를 마치고 홈에 들어가면, 다음에 앱을 열 때 바로 홈으로 갑니다. 전체 › 로그아웃은 시작 화면으로 돌아가며 이 상태를 초기화합니다.

## 개발

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # dist/  ← 서버에 올라가는 정적 파일
```

## iOS

Xcode 16+ 가 있는 Mac 에서:

```bash
npm run ios:sync     # 웹 빌드 + ios/ 에 복사·플러그인 동기화
npm run ios:open     # Xcode 에서 열기 → Signing 팀 설정 → Run
```

웹뷰가 무엇을 띄울지는 `capacitor.config.ts` 에서 정합니다.

| 방법 | 명령 | 동작 |
|---|---|---|
| 기본 (번들) | `npx cap sync ios` | `dist/` 를 앱 안에 넣어 실행. 인터넷 없이도 열림 |
| 서버 로드 | `CAP_SERVER_URL=https://<앱 도메인> npx cap sync ios` | eney.cloud 인스턴스에 배포된 앱을 로드. 연결 실패 시 번들된 `offline.html` |
| 라이브 리로드 | `CAP_SERVER_URL=http://<맥 IP>:5173 npx cap sync ios` | `npm run dev` 서버를 로드 |

iOS 는 HTTPS 가 아닌 주소를 막으므로(ATS), 서버 로드 방식은 도메인 + HTTPS 가 준비된 뒤에 쓰세요.

설정해 둔 것: 번들 ID `com.invisen.worker`(바꾸세요), 세로 고정, 다크 UI, 한국어 기본, 블루투스·위치 권한 문구, 앱 아이콘·스플래시(로고에서 생성), Haptics(iOS 웹뷰는 `navigator.vibrate` 미지원 → SOS 진동은 네이티브 Haptics), StatusBar.

## 서버 (eney.cloud 인스턴스)

`deploy/setup.sh` 한 번으로 서버 초기 설정, 보안 설정, 앱 배포를 합니다 (Ubuntu 22.04).

1. eney.cloud 콘솔에서 인스턴스에 **공인 IP** 를 붙이고, **방화벽 정책** 에 인바운드 22(내 IP만), 80, 443 을 엽니다.
2. 서버에 접속해 실행합니다.

```bash
ssh -i my-key.pem ubuntu@<공인 IP>
```

```bash
curl -fsSL https://raw.githubusercontent.com/junseo2323/invisen-app/main/deploy/setup.sh | sudo bash
```

도메인이 있으면 HTTPS 까지 켜집니다 (도메인 DNS A 레코드가 공인 IP 를 가리킨 뒤):

```bash
curl -fsSL https://raw.githubusercontent.com/junseo2323/invisen-app/main/deploy/setup.sh | sudo DOMAIN=app.example.com EMAIL=me@example.com SSH_ALLOW_FROM=<내 IP>/32 bash
```

하는 일:

| 영역 | 내용 |
|---|---|
| 패키지 | 전체 업데이트, 자동 보안 업데이트(unattended-upgrades), 시간대 Asia/Seoul, Node.js 22 |
| SSH | 키 로그인만 허용, root 로그인·비밀번호·포워딩 금지, 인증 3회 제한 (등록된 키가 없으면 잠기지 않게 건너뜀) |
| 방화벽 | ufw: 들어오는 연결 기본 차단, 22(속도 제한 또는 지정 IP만)·80·443 만 허용 |
| 침입 차단 | fail2ban: SSH 5회 실패 시 1시간 차단 |
| 커널 | SYN cookie, rp_filter, ICMP 리다이렉트·소스 라우팅 차단 |
| 앱 | 로그인 불가 계정 `invisen` 으로 저장소를 받아 빌드, `/var/www/invisen/releases/` 에 릴리스로 쌓고 `current` 링크를 원자적으로 교체 (최근 5개 보관) |
| nginx | 서버 버전 숨김, 보안 헤더(CSP, X-Frame-Options, nosniff, Referrer/Permissions-Policy, 도메인이 있으면 HSTS), 숨김 파일 차단, 빌드 파일 장기 캐시, gzip |
| HTTPS | `DOMAIN`+`EMAIL` 을 주면 Let's Encrypt 인증서 발급, HTTP→HTTPS 리다이렉트, 자동 갱신 |

이후 앱만 다시 배포: `sudo invisen-deploy`. 되돌리기: `sudo ln -sfn /var/www/invisen/releases/<이전 릴리스> /var/www/invisen/current`.

## 아직 안 된 것

- 데이터는 전부 디자인의 샘플 값입니다. eney.cloud API 연동 지점은 `src/screens/logic.ts` (`TODO: eney.cloud API`).
- BLE 센서 연결(블루투스 권한 문구만 있음), 위치, 푸시 알림, 전화 걸기 링크(`href="#"` 자리표시) 미연결.
- 전체 › "밝은 화면", "큰 글씨" 토글은 상태만 저장되고 화면에 반영되지 않습니다.

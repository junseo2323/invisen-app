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
npm run build        # dist/  ← eney.cloud 에 배포할 정적 파일
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
| 기본 | `npx cap sync ios` | `https://eney.cloud` 를 로드. 연결 실패 시 번들된 `offline.html` 표시 |
| 라이브 리로드 | `CAP_SERVER_URL=http://<맥 IP>:5173 npx cap sync ios` | `npm run dev` 서버를 로드 |
| 번들 | `CAP_BUNDLED=1 npx cap sync ios` | `dist/` 를 앱 안에 넣어 오프라인으로 실행 |

설정해 둔 것: 번들 ID `com.invisen.worker`(바꾸세요), 세로 고정, 다크 UI, 한국어 기본, 블루투스·위치 권한 문구, 앱 아이콘·스플래시(로고에서 생성), Haptics(iOS 웹뷰는 `navigator.vibrate` 미지원 → SOS 진동은 네이티브 Haptics), StatusBar.

## 아직 안 된 것

- 데이터는 전부 디자인의 샘플 값입니다. eney.cloud API 연동 지점은 `src/screens/logic.ts` (`TODO: eney.cloud API`).
- BLE 센서 연결(블루투스 권한 문구만 있음), 위치, 푸시 알림, 전화 걸기 링크(`href="#"` 자리표시) 미연결.
- 전체 › "밝은 화면", "큰 글씨" 토글은 상태만 저장되고 화면에 반영되지 않습니다.

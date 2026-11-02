# invisen 작업자 앱

현장 작업자용 미세먼지 노출 모니터링 앱. 웹앱(Vite + TypeScript)을 iOS WKWebView(Capacitor 8)로 감싸 배포하고,
API(Fastify + PostgreSQL)는 eney.cloud 인스턴스에서 Docker로 돌립니다.

```
design/              디자인 캔버스 원본 (14개 화면 .dc.html, 토큰)
src/                 앱 (웹뷰 안에서 도는 코드)
  screens/markup/    화면 마크업 — 디자인에서 가져와 {{값}} 을 데이터에 연결한 것
  screens/logic.ts   화면별 상태·동작
  monitor.ts         센서 연결 유지, 측정값 업로드(오프라인 큐), 주의/위험 알림
  sensor/            BLE 센서 드라이버 + 시뮬레이터
  native.ts          푸시, 로컬 알림, 위치, QR, 햅틱, 권한
server/              API + DB 마이그레이션 + 테스트
ios/                 Xcode 프로젝트 (Capacitor)
deploy/              서버 설정 스크립트, docker compose
.github/workflows/   CI, 배포
```

## 로컬 개발

PostgreSQL 16 이 있으면 됩니다.

```bash
createdb invisen
```

```bash
cd server && npm install && cp .env.example .env && npm run seed -- --demo && npm run dev
```

```bash
npm install && npm run dev
```

http://localhost:5173 → 시작하기 → `010-2481-3307`, 등록 코드 `000000` (개발용 고정값, `DEV_LOGIN_CODE`).
브라우저에는 블루투스가 없어서 시뮬레이터 센서가 붙습니다. 주소에 `?sim=caution` / `?sim=danger` 를 붙이면 주의·위험 상황을 재현합니다.

테스트: `cd server && npm test` (로컬 `invisen_test` DB 또는 `DATABASE_URL_TEST`).

### 데모 빌드

서버 없이 샘플 데이터 + 가상 센서로 도는 버전입니다 (등록 코드 `000000`, 화면 아래 `데모` 스위치로 안전·주의·위험 전환).

```bash
npm run build:demo
```

`dist-demo/invisen-demo.html` 한 파일로 나옵니다 (공유용). 일반 빌드에는 데모 코드가 들어가지 않습니다.

## 앱 흐름

| 단계 | 화면 | 하는 일 |
|---|---|---|
| 로그인 | 01 시작 → 02 등록 코드 | 휴대폰 번호 + 반장이 발급한 일회용 6자리 등록 코드 → 세션 토큰(30일) |
| 온보딩 | 03 소속 확인 → 04 센서 연결 → 05 착용·권한 | 등록 정보 확인, BLE 스캔/QR 로 센서 페어링, 블루투스·알림·위치 권한 |
| 홈 | 06 홈(안전) / 12 홈(주의) | 실시간 PM10, 오늘 누적, 교대까지 남은 시간. 상태에 따라 화면이 바뀜 |
| 위험 | 13 위험 알림 | 권고치 100% 이상이면 자동으로 뜸 + 진동 + 알림, 반장·관제실에 푸시/웹훅 |
| 탭 | 07 현장 · 08 센서값 · 09 노출량 · 10 기록 · 11 전체 | 팀 위치·공지, 센서 30분 추이, 8h TWA 누적 노출량, 기록 필터, 설정·연락처 |
| 긴급 | 14 SOS | 3초 누르면 위치와 함께 관제실·반장에게 전송, 취소 가능 |

상태 기준(디자인 그대로): 현재 농도 ÷ 구역 권고치 — 80% 이상 주의, 100% 이상 위험.
누적 노출량 = 8시간 시간가중평균 ÷ 권고치 (5분 넘게 끊긴 구간은 제외). 계산은 `server/src/exposure.ts`.

설정: 진동 알림, 큰 글씨, 밝은 화면(디자인 시스템 Light 토큰)이 실제로 적용됩니다.

## iOS

Xcode 16+ 가 있는 Mac 에서:

```bash
npm run ios:sync
```

```bash
npm run ios:open
```

Xcode 에서 Signing 팀을 고르고 실행합니다. 웹뷰가 무엇을 띄울지는 빌드할 때 정합니다.

| 방법 | 명령 | 동작 |
|---|---|---|
| 번들 (기본) | `VITE_API_URL=https://<도메인> npm run ios:sync` | 앱 안에 웹앱을 넣고 API 만 서버로 호출. 오프라인에서도 열림 |
| 서버 로드 | `CAP_SERVER_URL=https://<도메인> npm run ios:sync` | 서버에 배포된 웹앱을 로드 (배포하면 앱 업데이트 없이 반영) |
| 시뮬레이터 | `VITE_SENSOR=sim VITE_API_URL=… npm run ios:sync` | iOS 시뮬레이터엔 블루투스가 없어서 시뮬레이터 센서 사용 |

iOS 는 HTTPS 가 아닌 주소를 막습니다(ATS). 도메인 + HTTPS 가 생긴 뒤에 위 명령을 쓰세요.

넣어 둔 네이티브 기능:

| 기능 | 플러그인 | 비고 |
|---|---|---|
| 센서 연결 | `@capacitor-community/bluetooth-le` | 백그라운드 BLE(`bluetooth-central`), 자동 재연결 |
| 푸시 | `@capacitor/push-notifications` | APNs 토큰을 서버에 등록. Push 엔타이틀먼트 포함 |
| 로컬 알림 | `@capacitor/local-notifications` | 백그라운드에서 주의/위험 알림, 탭하면 해당 화면 |
| 위치 | `@capacitor/geolocation` | SOS 보낼 때만 |
| QR | `@capacitor/barcode-scanner` | 센서 뒷면 QR 로 페어링 |
| 저장 | `@capacitor/preferences` | 세션 토큰, 설정, 업로드 대기열 |
| 햅틱 | `@capacitor/haptics` | iOS 웹뷰엔 `navigator.vibrate` 가 없어서 |
| 앱 상태 | `@capacitor/app` | 복귀 시 상태 갱신·재연결 |

Apple 쪽에서 할 일: 번들 ID `com.invisen.worker` 를 실제 값으로 변경, Developer 계정에서 Push Notifications 켜기,
APNs 키(.p8) 발급 → 서버 `/etc/invisen/api.env` 에 입력. SOS 를 무음 모드에서도 울리게 하려면 Critical Alerts 권한을 Apple 에 신청해야 합니다.

### 센서 BLE 프로토콜 (교체 필요)

`src/sensor/protocol.ts` 의 서비스 UUID 와 패킷 해석은 **임시값**입니다. 센서 제조사 GATT 사양을 받으면 이 파일만 바꾸면 됩니다.
나머지(업로드, 알림, 화면)는 `parseMeasurement()` 결과만 씁니다.

## 서버 (eney.cloud 인스턴스)

Ubuntu 22.04 에 SSH 로 접속해서 한 번 실행합니다. 여러 번 실행해도 안전합니다.

```bash
curl -fsSL https://raw.githubusercontent.com/junseo2323/invisen-app/main/deploy/setup.sh | sudo bash
```

도메인이 생기면 (DNS A 레코드 → 서버 공인 IP 연결 후) 같은 명령에 값을 붙여 다시 실행하면 HTTPS 가 켜집니다:

```bash
curl -fsSL https://raw.githubusercontent.com/junseo2323/invisen-app/main/deploy/setup.sh | sudo DOMAIN=app.example.com EMAIL=me@example.com bash
```

| 영역 | 내용 |
|---|---|
| 보안 | 자동 보안 업데이트, SSH 키 로그인만, ufw(22·80·443), fail2ban, 커널 네트워크 설정 |
| 구성 | nginx(웹앱 + `/api` 프록시, 보안 헤더) → API 컨테이너(127.0.0.1:3000) → PostgreSQL 컨테이너(내부망 전용) |
| 비밀값 | `/etc/invisen/compose.env`(DB 비밀번호), `/etc/invisen/api.env`(등록 코드 비밀, APNs·웹훅) — 처음 실행 때 무작위 생성, root 만 읽기 |
| HTTPS | Let's Encrypt(webroot), HTTP→HTTPS, HTTP/2, HSTS, 자동 갱신 |
| 배포 | `invisen-deploy.timer` 가 1분마다 `production` 브랜치 확인 → 웹 빌드 → API/DB 갱신(마이그레이션) → 헬스체크 통과 시 교체. 실패하면 이전 버전 유지 |
| 백업 | 매일 03:30 `pg_dump` → `/var/backups/invisen` (14일 보관) |

처음 설치 후 내 계정 만들기 (샘플 현장·구역·센서 + 내 번호로 로그인할 계정, 등록 코드가 출력됨):

```bash
sudo invisen-admin seed --me "이름:010XXXXXXXX"
```

### 로그인 (등록 코드)

문자 인증 대신, 반장이 작업자별로 일회용 6자리 등록 코드를 발급하고 작업자는 휴대폰 번호 + 코드로 로그인합니다.
코드는 72시간 유효, 한 번만 쓸 수 있고, 5번 틀리면 잠깁니다. 새로 발급하면 이전 코드는 무효가 됩니다.

- 관리자 대시보드에서: `POST /api/admin/invites` `{ "phone": "010…" }` 또는 `{ "workerId": 3 }` (반장 계정 세션 필요, 같은 현장 작업자만)
- 대시보드가 생기기 전 / 첫 반장 계정: `sudo invisen-admin invite 010XXXXXXXX`

관리: `sudo invisen-admin status | logs | restart | invite | psql | backup`

## CI/CD

```
push ─▶ CI (웹 빌드 · API 테스트(PostgreSQL) · Docker 이미지 · compose · shellcheck)
              │ main 에서 통과
              ▼
        Deploy 워크플로 ─▶ production 브랜치를 그 커밋으로 이동
                                   │ 1분 안에
                                   ▼
                     서버 invisen-deploy (pull 방식) ─▶ /api/health 의 version 이 그 커밋으로 바뀜
```

서버로 들어가는 SSH 를 쓰지 않습니다. eney.cloud 방화벽은 SSH 를 특정 IP 에만 열 수 있는데 Actions 러너 IP 는 매번 바뀌기 때문입니다.

- 수동 배포/되돌리기: Actions › Deploy › Run workflow 에 커밋 SHA·태그를 넣기
- 저장소 변수 `PRODUCTION_URL`(예: `https://app.example.com`)을 넣으면 Deploy 가 서버 반영까지 기다려 확인합니다
- 승인 후 배포를 원하면: Settings › Environments › production › Required reviewers
- 저장소를 비공개로 바꾸면 서버가 코드를 받을 수 있게 deploy key 설정이 추가로 필요합니다

## 아직 안 된 것

- 센서 BLE 프로토콜은 임시값 (위 참고)
- 작업자 위치(구역·지도 좌표)는 서버 DB 값을 그대로 씁니다. 실내 측위(비콘 등)와 연동하는 부분이 아직 없습니다
- 관리자 대시보드 없음: 등록 코드 발급 API 는 준비됨. 작업자·센서·공지 관리는 아직 `invisen-admin` 또는 DB 직접
- 앱이 완전히 종료돼 있으면 측정이 멈춥니다(웹뷰 기반 한계). 백그라운드 BLE 는 켜 두었지만 iOS 가 앱을 오래 멈추면 업로드가 지연될 수 있습니다
- 실기기 테스트 전: Xcode 빌드, 푸시, BLE, QR 은 이 환경(리눅스)에서 실행해보지 못했습니다

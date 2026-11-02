# TestFlight 올리기

앱 쪽 준비는 끝나 있습니다. 남은 건 **도메인**, **Apple 계정 설정**, **GitHub 에 키 넣고 실행** 세 가지입니다.

준비돼 있는 것: iPhone 전용 빌드 설정, 권한 문구(블루투스·위치·카메라·알림), 개인정보 매니페스트(PrivacyInfo.xcprivacy),
수출 규정 답변(암호화 없음 → 업로드마다 묻지 않음), 버전 1.0.0, 빌드 번호 자동 증가, 공유 스킴, 업로드 워크플로,
심사용 로그인, 개인정보 처리방침 페이지(`/privacy.html`).

---

## 1. 도메인이 생기면 (약 10분)

1. 도메인 DNS 에 A 레코드 추가: `app.<도메인>` (또는 루트) → `203.240.226.48`
2. 서버에서 설치 명령을 도메인과 함께 다시 실행 (HTTPS 인증서 발급):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/junseo2323/invisen-app/main/deploy/setup.sh | DOMAIN=app.example.com EMAIL=me@example.com bash
   ```

3. 확인: `https://app.example.com/api/health` 가 `{"ok":true,...}`
4. GitHub › Settings › Secrets and variables › Actions › **Variables**
   - `API_URL` = `https://app.example.com` (앱이 부를 서버)
   - `PRODUCTION_URL` = `https://app.example.com` (배포 확인용, 선택)

## 2. Apple 쪽 (처음 한 번)

1. **Apple Developer Program 가입** — TestFlight 에 필수, 유료(연 99달러). 회사 이름으로 내려면 법인 + D-U-N-S 번호가 필요하고 발급에 며칠 걸립니다.
2. **번들 ID 정하기** — 지금은 `com.invisen.worker`. 회사 도메인 기준으로 바꾸려면:

   ```bash
   node scripts/set-bundle-id.mjs com.yourcompany.invisen
   ```

   (바꾼 뒤 커밋·푸시. 앱스토어에 한 번 올리면 못 바꿉니다.)
3. [developer.apple.com](https://developer.apple.com/account/resources/identifiers/list) › Identifiers › **+** › App IDs → 위 번들 ID 등록, Capabilities 에서 **Push Notifications** 체크
4. [App Store Connect](https://appstoreconnect.apple.com/apps) › 앱 › **+ 신규 앱**: iOS, 이름 `invisen`(겹치면 `invisen 작업자`), 기본 언어 한국어, 번들 ID 선택, SKU `invisen-worker`
5. App Store Connect › 사용자 및 액세스 › 통합 › **App Store Connect API** › 팀 키 생성
   - 역할 **관리자(Admin)** — 빌드할 때 Xcode 가 배포 인증서·프로비저닝을 알아서 만들려면 필요
   - `.p8` 파일은 **한 번만** 받을 수 있어요. Key ID, Issuer ID 도 적어 두기
6. Team ID: developer.apple.com › Membership details 의 10자리
7. (푸시) developer.apple.com › Keys › **+** › Apple Push Notifications service (APNs) → `.p8`, Key ID.
   서버 `/etc/invisen/api.env` 에 넣고 `invisen-admin restart`:

   ```
   APNS_KEY_ID=XXXXXXXXXX
   APNS_TEAM_ID=XXXXXXXXXX
   APNS_KEY=-----BEGIN PRIVATE KEY-----\nMIG...\n-----END PRIVATE KEY-----
   APNS_TOPIC=com.invisen.worker
   APNS_PRODUCTION=true
   ```

   TestFlight·App Store 빌드는 **production** APNs 를 쓰므로 `APNS_PRODUCTION=true`.

## 3. GitHub 에 키 넣기

GitHub › Settings › Secrets and variables › Actions › **Secrets**

| 이름 | 값 |
|---|---|
| `ASC_KEY_ID` | API 키 ID |
| `ASC_ISSUER_ID` | Issuer ID |
| `ASC_KEY_P8` | `.p8` 를 base64 로: Mac 터미널에서 `base64 -i AuthKey_XXXX.p8 \| pbcopy` 후 붙여넣기 |
| `APPLE_TEAM_ID` | Team ID |

## 4. 올리기

**GitHub Actions (Mac 없어도 됨)**: Actions › **iOS TestFlight** › Run workflow → 20~30분.
빌드 번호는 TestFlight 최신 + 1 로 자동. 끝나면 App Store Connect › TestFlight 에 빌드가 보이고, Apple 처리(10~30분) 후 테스트할 수 있습니다.

**Mac 의 Xcode 로 직접**:

```bash
VITE_API_URL=https://app.example.com npm run ios:release
```

```bash
npm run ios:open
```

Xcode › App 타깃 › Signing & Capabilities 에서 Team 선택 → Product › Archive → Distribute App › TestFlight & App Store.
(직접 올릴 때는 빌드 번호를 매번 올려야 합니다: General › Build)

## 5. 테스터

- **내부 테스터** (App Store Connect 에 등록한 팀원, 최대 100명): 심사 없이 바로 설치. TestFlight › 내부 테스트 › 그룹에 빌드 추가.
- **외부 테스터** (이메일·공개 링크, 최대 10,000명): 그룹의 첫 빌드는 Apple **베타 심사**(보통 하루 안). 필요한 것:
  - 테스트 정보: 설명, 피드백 이메일, 개인정보 처리방침 URL `https://app.example.com/privacy.html`
  - 심사용 로그인 — 서버 `/etc/invisen/api.env` 에 넣고 `invisen-admin restart`:

    ```
    REVIEW_PHONE=01012345678
    REVIEW_CODE=123456
    ```

    심사 정보 칸에 번호와 코드를 적고, 메모에 "센서 없이 가상 센서로 동작하는 심사용 계정입니다"라고 적기.
    이 계정은 앱에서 가상 센서를 쓰고, 다른 작업자의 팀 목록에는 안 보입니다. 심사가 끝나면 두 줄을 비우세요.
- 테스터는 iPhone 에 **TestFlight** 앱을 깔고 초대를 수락합니다. 로그인은 등록 코드: `invisen-admin invite 010XXXXXXXX`

**실제 센서 사양이 들어오기 전**에는 iPhone 에서 실제 센서를 못 찾습니다. 그동안 테스트할 작업자는 가상 센서 계정으로 바꿔 주세요:

```bash
invisen-admin demo 010XXXXXXXX on
```

## 첫 빌드 전에 확인할 것

- `public/privacy.html` 의 노란 `[ ]` 칸 채우기 (회사명, 보호책임자, 보관 기간) — 외부 테스트·출시 전 필수
- 앱 아이콘은 로고로 만든 임시본 (`ios/App/App/Assets.xcassets/AppIcon.appiconset`, 1024×1024, 투명 배경 금지)
- 센서 BLE 사양은 임시값 (`src/sensor/protocol.ts`)
- 업로드 워크플로는 리눅스 환경에서 만들어 아직 실제로 돌려보지 못했습니다. 첫 실행에서 서명 단계가 실패하면 Actions 의 `xcode-logs` 와 로그를 보고 고치면 됩니다

# 도메인 연결 작업 지시서 (로컬 Claude Code + Chrome 용)

이 문서는 사용자 컴퓨터에서 `claude --chrome` 으로 띄운 Claude Code 가 읽고 그대로 진행하는 작업 지시서다.
목표: 사용자가 산 도메인을 invisen 서버(server2, `203.240.226.48`)에 연결하고 HTTPS 를 켠 뒤,
앱 API 주소와 관리자 대시보드가 `https://<도메인>` 으로 동작하는 것까지 확인한다.

## 지금 상태 (2026-11-03 완료)

- **연결 끝.** 도메인 `invisen.kr`(가비아 DNS) → `app.invisen.kr`, `admin.invisen.kr` A 레코드 → `203.240.226.48`.
  - 앱·API: `https://app.invisen.kr/` · `https://app.invisen.kr/api/health`
  - 관리자 대시보드: `https://admin.invisen.kr/` (→ `/admin/`, `https://app.invisen.kr/admin/` 도 그대로 열림)
  - 인증서: Let's Encrypt 한 장에 두 이름 (certbot 자동 갱신). 서버 실행값 `DOMAIN=app.invisen.kr ADMIN_DOMAIN=admin.invisen.kr`
  - GitHub 저장소 변수 `API_URL`, `PRODUCTION_URL` = `https://app.invisen.kr`
- eney 웹 콘솔(VNC)로 명령을 칠 때: 브라우저 자동 입력은 **Shift 가 안 먹는다** (`| @ : $ & ( ) _ " > {}` 등이 깨짐, Ctrl 조합도 안 됨).
  Shift 없는 문자만으로 쓴다. 예: `curl --proto-default https -fsSL -o /root/setup.sh raw.githubusercontent.com/…/setup.sh`
  (`https:` 와 파이프 없이), 이메일의 `@` 는 `sed -i '<줄>c EMAIL=me\x40example.com' /root/setup.sh` 로 넣는다.

아래는 연결 전(처음) 기준 설명이다.

- 서버: eney.cloud 인스턴스 server2, Ubuntu 22.04, 공인 IP `203.240.226.48`.
  - 앱 웹: `http://203.240.226.48/` · API: `/api/health` · 관리자 대시보드: `/admin/` (admin / admin)
  - 설치·보안·nginx·자동 배포는 `deploy/setup.sh` 가 한다. 여러 번 실행해도 안전하고, 비밀값(`/etc/invisen/*.env`)·DB 는 그대로 둔다.
  - 자동 배포: `main` 이 CI 를 통과하면 `production` 브랜치로 옮겨지고 서버가 1분 안에 받아 간다.
- HTTPS: `DOMAIN` + `EMAIL` 을 붙여 setup.sh 를 다시 돌리면 Let's Encrypt 인증서 발급 → nginx 에 443 + HTTP→HTTPS 리디렉션 + HSTS 가 켜진다.
- 앱(iOS): API 주소는 빌드할 때 `VITE_API_URL=https://<도메인>` 으로 들어간다. GitHub 저장소 변수 `API_URL` 을 iOS TestFlight 워크플로가 쓴다.

## 지켜야 할 것

- **차단 기능을 넣지 말 것.** fail2ban, SSH 자동 차단, sshd 설정 변경을 하지 않는다. 사용자가 예전에 이걸로 서버에서 잠긴 적이 있다.
  setup.sh 가 하는 것 외에 SSH/방화벽 설정을 손대지 않는다.
- setup.sh 를 돌리기 전에 **SSH 창을 하나 더 열어 두고**, 끝난 뒤 새 창으로 다시 접속되는지 확인하고 나서 닫는다.
- SSH 개인키(`my-key.pem` 등)는 읽거나 업로드하거나 출력하지 않는다. `ssh -i <경로>` 로만 쓴다.
- DNS·방화벽·GitHub 설정을 바꾸기 전에 무엇을 어떻게 바꿀지 사용자에게 한 번 보여주고 진행한다.
- 결제·도메인 구매·약관 동의 화면이 나오면 멈추고 사용자에게 넘긴다. 로그인·캡차도 사용자에게 넘긴다.

## 0. 사용자에게 먼저 물어볼 것 (한 번에)

1. 연결할 주소: 루트(`example.com`)인지 서브도메인(`app.example.com`, 권장)인지
2. Let's Encrypt 연락용 이메일
3. 도메인을 산 곳(가비아, 후이즈, Cloudflare 등)과 그 사이트에 Chrome 으로 로그인돼 있는지
4. 서버 접속에 쓰는 키 파일 경로와 계정 (예전 안내: `ssh -o IdentitiesOnly=yes -i ~/Downloads/my-key.pem root@203.240.226.48`)

아래에서 `<도메인>` 은 1번 답, `<이메일>` 은 2번 답이다.

## 1. DNS (Chrome 으로 도메인 관리 화면)

- `<도메인>` 에 **A 레코드 → `203.240.226.48`**, TTL 은 가장 짧게(300초 등).
- 같은 이름에 다른 A/AAAA/CNAME, 업체 기본 "파킹/포워딩" 이 있으면 지운다 (AAAA 가 남아 있으면 인증서 발급이 실패할 수 있다).
- Cloudflare 라면 프록시(주황 구름)를 **끄고(DNS only)** 시작한다. 인증서 발급 후 켜도 되지만 그땐 SSL 모드를 Full(strict) 로.
- 확인 (사용자 컴퓨터 터미널):

  ```bash
  dig +short <도메인> @1.1.1.1
  dig +short <도메인> @8.8.8.8
  ```

  둘 다 `203.240.226.48` 이 나올 때까지 기다린다 (보통 몇 분, 길면 한 시간).

## 2. eney.cloud 방화벽 (Chrome 으로 콘솔)

- server2 의 [네트워크 › 방화벽 정책] 인바운드에 **TCP 80, TCP 443 이 전체(0.0.0.0/0)로 열려 있는지** 확인하고, 없으면 추가한다.
  `0.0.0.0/32` 는 "전체" 가 아니다(한 주소만). SSH(22)는 지금처럼 사용자 IP 만 열린 상태 그대로 둔다.
- 확인:

  ```bash
  curl -sI -m 5 http://<도메인>/ | head -1
  ```

  `HTTP/1.1 200 OK` 면 80 은 된다.

## 3. 서버에서 HTTPS 켜기

```bash
ssh -o IdentitiesOnly=yes -i <키 경로> root@203.240.226.48
```

서버 안에서 (DNS 가 이미 서버를 가리켜야 한다):

```bash
curl -fsSL https://raw.githubusercontent.com/junseo2323/invisen-app/main/deploy/setup.sh | sudo DOMAIN=<도메인> EMAIL=<이메일> bash
```

- 마지막에 `앱: https://<도메인>/` 이 나오면 성공. "인증서 발급 실패" 가 나오면 1·2단계를 다시 확인하고 같은 명령을 다시 돌린다.
- 이 실행으로 관리자 대시보드용 `invisen-admin admin-password` 명령과 `/admin/` 캐시 설정도 함께 반영된다.
- `/etc/invisen/api.env` 의 `CORS_ORIGINS` 는 바꿀 필요 없다 (앱은 `capacitor://localhost`, 대시보드는 같은 도메인).
- 끝나면 **다른 터미널에서 SSH 재접속이 되는지** 확인한다.

## 4. 확인

```bash
curl -sI http://<도메인>/ | head -3
```

`301` 과 `Location: https://…` 가 나와야 한다.

```bash
curl -s https://<도메인>/api/health
```

`{"ok":true,"version":"…"}` 가 나와야 한다.

```bash
curl -sI https://<도메인>/admin/ | head -1
```

`200` 이 나와야 한다.

Chrome 에서:
- `https://<도메인>/admin/` 열기 → admin / admin 로그인 → 위에 노란 "처음 받은 비밀번호" 안내가 뜨면
  **사용자에게 새 비밀번호를 정하게 하고** 설정 › 관리자 › 비밀번호 변경. (비밀번호는 Claude 가 정하지 않는다.)
- 관제 홈 · 작업자 · 알림 · 보고서 · 센서 · 설정이 열리는지, 콘솔 에러가 없는지 본다.
- `https://<도메인>/privacy.html` (App Store 심사용 개인정보 처리방침) 이 열리는지 본다.

## 5. GitHub 저장소 변수

사용자 컴퓨터에 `gh` 가 로그인돼 있으면:

```bash
gh variable set API_URL --body "https://<도메인>" --repo junseo2323/invisen-app
```

```bash
gh variable set PRODUCTION_URL --body "https://<도메인>" --repo junseo2323/invisen-app
```

없으면 Chrome 으로 GitHub › 저장소 › Settings › Secrets and variables › Actions › Variables 에서 같은 두 값을 넣는다.
- `API_URL`: iOS TestFlight 빌드가 부를 서버
- `PRODUCTION_URL`: Deploy 워크플로가 배포 후 실제 서버 반영까지 확인

## 6. 저장소 문서 갱신 후 커밋

- `README.md`, `docs/TESTFLIGHT.md` 의 `app.example.com` 예시는 그대로 두고, README 의 "서버" 절에 실제 주소 한 줄(`https://<도메인>`)을 추가.
- 이 문서(`docs/DOMAIN-HANDOFF.md`) 맨 위 "지금 상태" 를 완료 상태로 고친다.
- 커밋해서 `main` 에 push (CI 통과 후 자동 배포됨. 문서 변경이라 서버 동작은 그대로).

## 7. 사용자에게 보고

- 열린 주소: `https://<도메인>/`, `https://<도메인>/admin/`, `https://<도메인>/api/health`
- 인증서는 certbot 이 자동 갱신 (서버 `systemctl list-timers | grep certbot`)
- 다음 단계: Apple 쪽 설정과 TestFlight 업로드 → `docs/TESTFLIGHT.md` 2단계부터 (사용자가 Apple 설정은 나중에 한다고 함)

## 문제가 생기면

| 증상 | 확인 |
|---|---|
| 인증서 발급 실패 | `dig` 결과가 `203.240.226.48` 인지, AAAA 레코드가 없는지, 80 포트가 열렸는지 |
| https 접속이 안 됨 | eney 방화벽 443, 서버에서 `sudo ufw status` (80/443 허용), `sudo nginx -t` |
| API 502 | `sudo invisen-admin status`, `sudo invisen-admin logs 100` |
| 대시보드가 옛 화면 | 강력 새로고침. 배포 버전은 `/api/health` 의 version |
| 관리자 비밀번호 분실 | 서버에서 `sudo invisen-admin admin-password admin` (임시 비밀번호 출력) |

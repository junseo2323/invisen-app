#!/usr/bin/env bash
# invisen 서버 초기 설정 + 보안 설정 + 앱/API/DB 배포 (Ubuntu 22.04, eney.cloud 인스턴스)
#
#   curl -fsSL https://raw.githubusercontent.com/junseo2323/invisen-app/main/deploy/setup.sh | sudo bash
#
# 옵션 (환경변수, sudo 뒤에 붙여서: curl … | sudo DOMAIN=app.example.com EMAIL=me@example.com bash)
#   DOMAIN          앱 도메인. 있으면 Let's Encrypt HTTPS + HSTS 를 켭니다.
#   EMAIL           Let's Encrypt 연락처 (DOMAIN 과 함께).
#   SSH_ALLOW_FROM  SSH 를 허용할 IP/CIDR (예: 203.0.113.7/32). 비우면 ufw 는 어디서나 허용 (eney 방화벽에서 내 IP 만 열기).
#   REPO_URL, REF   배포할 저장소와 브랜치 (기본: junseo2323/invisen-app, production → 없으면 main)
#
# 여러 번 실행해도 안전합니다.
# 이후 배포는 자동: GitHub Actions 가 CI 를 통과한 main 을 production 브랜치로 올리면 서버가 1분 안에 받아 배포.
# 수동 배포: sudo invisen-deploy    관리 도구: sudo invisen-admin help
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/junseo2323/invisen-app.git}"
REF="${REF:-production}"
DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
SSH_ALLOW_FROM="${SSH_ALLOW_FROM:-}"
APP_USER="invisen"
APP_HOME="/opt/invisen"
WEB_ROOT="/var/www/invisen"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[주의] %s\033[0m\n' "$*"; }

main() {
[[ $EUID -eq 0 ]] || { echo "sudo 로 실행하세요." >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

# ---------------------------------------------------------------------------
log "1/9 패키지 업데이트, 기본 도구 설치"
apt-get update -y
apt-get -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade -y
apt-get install -y ca-certificates curl git gnupg openssl ufw unattended-upgrades nginx rsync
timedatectl set-timezone Asia/Seoul || true

if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1)" != "v22" ]]; then
  log "Node.js 22 설치"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! docker compose version >/dev/null 2>&1; then
  log "Docker 설치 (공식 저장소)"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" >/etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
mkdir -p /etc/docker
[[ -f /etc/docker/daemon.json ]] || echo '{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "5" } }' >/etc/docker/daemon.json
systemctl enable --now docker

# ---------------------------------------------------------------------------
log "2/9 자동 보안 업데이트"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
systemctl enable --now unattended-upgrades

# ---------------------------------------------------------------------------
log "3/9 SSH: 키 로그인만 (지금 접속한 계정의 키 로그인은 그대로 유지)"
# sshd 는 처음 읽은 값을 쓰고 drop-in 은 이름순으로 읽으므로 00- 으로 둬서
# 50-cloud-init.conf 의 PasswordAuthentication yes 보다 먼저 적용되게 한다.
has_keys=0
for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
  [[ -s "$f" ]] && has_keys=1
done
# root 로 접속해서 실행했으면 root 키 로그인은 남겨둔다 (막으면 SSH 가 잠김).
# 키가 있는 일반 계정에서 sudo 로 실행했을 때만 root 로그인을 완전히 막는다.
root_login="prohibit-password"
admin="${SUDO_USER:-root}"
if [[ "$admin" != "root" && -s "$(getent passwd "$admin" | cut -d: -f6)/.ssh/authorized_keys" ]]; then
  root_login="no"
fi
if [[ $has_keys -eq 1 ]]; then
  cat >/etc/ssh/sshd_config.d/00-invisen-hardening.conf <<CONF
PermitRootLogin $root_login
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
CONF
  if sshd -t; then
    systemctl reload ssh || systemctl reload sshd || true
  else
    rm -f /etc/ssh/sshd_config.d/00-invisen-hardening.conf
    warn "sshd 설정 검사 실패 — SSH 설정은 바꾸지 않았습니다."
  fi
else
  warn "등록된 SSH 키(authorized_keys)가 없어 비밀번호 로그인을 끄지 않았습니다. 잠기지 않도록 건너뜀."
fi

# ---------------------------------------------------------------------------
log "4/9 방화벽 (ufw): SSH, HTTP, HTTPS 만 허용"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
if [[ -n "$SSH_ALLOW_FROM" ]]; then
  ufw allow from "$SSH_ALLOW_FROM" to any port 22 proto tcp comment 'ssh (admin)'
else
  ufw allow 22/tcp comment 'ssh'
fi
ufw allow 80/tcp comment 'http'
ufw allow 443/tcp comment 'https'
ufw --force enable
# (API 는 127.0.0.1:3000 에만, DB 는 컨테이너 내부망에만 열리므로 외부에 노출되지 않음)

# 자동 차단 기능은 쓰지 않는다 (예전 버전이 설치했다면 끈다). SSH 는 eney.cloud 방화벽에서 내 IP 로만 연다.
if systemctl list-unit-files fail2ban.service >/dev/null 2>&1; then
  systemctl disable --now fail2ban >/dev/null 2>&1 || true
fi

log "5/9 커널 네트워크 보안 설정"
cat >/etc/sysctl.d/90-invisen.conf <<'CONF'
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.icmp_echo_ignore_broadcasts = 1
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
CONF
sysctl --system >/dev/null

# ---------------------------------------------------------------------------
log "6/9 비밀값 (/etc/invisen, root 만 읽기)"
install -d -m 700 /etc/invisen /var/lib/invisen /var/backups/invisen
if [[ ! -f /etc/invisen/compose.env ]]; then
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >/etc/invisen/compose.env
fi
if [[ ! -f /etc/invisen/api.env ]]; then
  cat >/etc/invisen/api.env <<CONF
# invisen API 설정. 바꾼 뒤: sudo invisen-admin restart
INVITE_SECRET=$(openssl rand -hex 32)
CORS_ORIGINS=capacitor://localhost
# APNs (반장 푸시). .p8 내용을 한 줄로: APNS_KEY=-----BEGIN PRIVATE KEY-----\nMIG...\n-----END PRIVATE KEY-----
APNS_KEY_ID=
APNS_TEAM_ID=
APNS_KEY=
APNS_TOPIC=com.invisen.worker
APNS_PRODUCTION=false
# 관제실 알림용 웹훅 (Dooray/Slack 호환)
ALERT_WEBHOOK_URL=
# App Store 심사용 고정 로그인 (외부 테스트·심사 때만, 끝나면 비우기): 휴대폰 번호 + 6자리
REVIEW_PHONE=
REVIEW_CODE=
CONF
fi
chmod 600 /etc/invisen/*.env

# ---------------------------------------------------------------------------
log "7/9 앱 · API · DB 배포"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$WEB_ROOT/releases" /var/www/letsencrypt

cat >/usr/local/bin/invisen-deploy <<SCRIPT
#!/usr/bin/env bash
# 배포: 저장소의 production 브랜치(없으면 main)를 받아 웹 빌드 → API/DB 컨테이너 갱신 → 웹 릴리스 교체.
#   invisen-deploy               지금 배포
#   invisen-deploy --if-changed  새 커밋이 있을 때만 (systemd 타이머가 1분마다 실행)
# 실패하면 지금 버전이 그대로 남고, 같은 커밋은 자동으로 다시 시도하지 않는다 (수동 실행은 가능).
set -euo pipefail
exec 9>/run/invisen-deploy.lock
flock -n 9 || { echo "이미 배포 중"; exit 0; }
REPO_URL="\${REPO_URL:-$REPO_URL}"
REF="\${REF:-$REF}"
SRC="$APP_HOME/src"
COMPOSE=(docker compose -f "\$SRC/deploy/compose.yml" --env-file /etc/invisen/compose.env)

remote_sha() { git ls-remote "\$REPO_URL" "refs/heads/\$1" 2>/dev/null | cut -f1; }
ref="\$REF"; sha="\$(remote_sha "\$ref")"
if [[ -z "\$sha" ]]; then ref=main; sha="\$(remote_sha main)"; fi
[[ -n "\$sha" ]] || { echo "저장소에 접근할 수 없어요: \$REPO_URL"; exit 1; }
if [[ "\${1:-}" == "--if-changed" ]]; then
  [[ "\$(cat /var/lib/invisen/deployed 2>/dev/null)" == "\$sha" ]] && exit 0
  [[ "\$(cat /var/lib/invisen/failed 2>/dev/null)" == "\$sha" ]] && exit 0
fi
echo "배포 시작: \$ref@\${sha:0:7}"
trap 'echo "\$sha" > /var/lib/invisen/failed; echo "배포 실패: \${sha:0:7} (지금 버전 유지)" >&2' ERR

if [[ ! -d "\$SRC/.git" ]]; then
  sudo -u $APP_USER git clone --depth 1 --branch "\$ref" "\$REPO_URL" "\$SRC"
else
  sudo -u $APP_USER git -C "\$SRC" fetch --depth 1 origin "\$ref"
  sudo -u $APP_USER git -C "\$SRC" reset --hard FETCH_HEAD
fi
cd "\$SRC"

# web
sudo -u $APP_USER -H npm ci --no-audit --no-fund
sudo -u $APP_USER -H npm run build
REL="$WEB_ROOT/releases/\$(date +%Y%m%d-%H%M%S)-\${sha:0:7}"
mkdir -p "\$REL"
rsync -a --delete "\$SRC/dist/" "\$REL/"
chown -R root:root "\$REL"
chmod -R a+rX,go-w "\$REL"

# api + db (DB 마이그레이션은 API 가 시작할 때 실행)
GIT_SHA="\$sha" "\${COMPOSE[@]}" up -d --build --remove-orphans
for _ in \$(seq 1 45); do
  curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS http://127.0.0.1:3000/api/health >/dev/null || { "\${COMPOSE[@]}" logs --tail 50 api >&2; false; }

# API 가 정상일 때만 웹 릴리스를 바꾼다 (되돌리기: ln -sfn <이전 릴리스> $WEB_ROOT/current)
ln -sfn "\$REL" "$WEB_ROOT/current.tmp"
mv -Tf "$WEB_ROOT/current.tmp" "$WEB_ROOT/current"
ls -1dt $WEB_ROOT/releases/* | tail -n +6 | xargs -r rm -rf
docker image prune -f >/dev/null 2>&1 || true
echo "\$sha" > /var/lib/invisen/deployed
rm -f /var/lib/invisen/failed
echo "배포 완료: \$ref@\${sha:0:7}"
SCRIPT
chmod 755 /usr/local/bin/invisen-deploy

cat >/usr/local/bin/invisen-admin <<'SCRIPT'
#!/usr/bin/env bash
# invisen 서버 관리 도구
set -euo pipefail
COMPOSE=(docker compose -f /opt/invisen/src/deploy/compose.yml --env-file /etc/invisen/compose.env)
case "${1:-help}" in
  status)   "${COMPOSE[@]}" ps; systemctl --no-pager list-timers 'invisen-*'; echo "배포된 커밋: $(cat /var/lib/invisen/deployed 2>/dev/null)";;
  logs)     "${COMPOSE[@]}" logs --tail "${2:-100}" -f api;;
  restart)  "${COMPOSE[@]}" up -d --force-recreate api;;
  seed)     shift; "${COMPOSE[@]}" exec api node dist/src/seed.js "$@";;
  psql)     "${COMPOSE[@]}" exec db psql -U invisen invisen;;
  backup)   /usr/local/bin/invisen-backup;;
  invite)   shift; "${COMPOSE[@]}" exec api node dist/src/invite.js "$@";;
  demo)     # demo <휴대폰> on|off : 가상 센서 계정으로 전환 (실제 센서 사양 전 테스트용)
            [[ -n "${2:-}" && "${3:-}" =~ ^(on|off)$ ]] || { echo "사용법: invisen-admin demo 010XXXXXXXX on|off"; exit 1; }
            printf '%s\n' "update workers set is_demo = (:'state' = 'on') where phone = regexp_replace(:'phone', '\\D', '', 'g') returning name, phone, is_demo;" \
              | "${COMPOSE[@]}" exec -T db psql -U invisen invisen -v phone="$2" -v state="$3";;
  admin-password) # admin-password <아이디> [새 비밀번호] : 관리자 대시보드 비밀번호 초기화
            [[ -n "${2:-}" ]] || { echo "사용법: invisen-admin admin-password <아이디> [새 비밀번호]"; exit 1; }
            pw="${3:-$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-12)}"
            (( ${#pw} >= 8 )) || { echo "비밀번호는 8자 이상이어야 해요"; exit 1; }
            user=$(printf '%s\n' "with a as (update admins set password_hash = crypt(:'pw', gen_salt('bf', 10)), must_change_password = true, active = true where lower(username) = lower(:'u') returning id, username), s as (delete from admin_sessions where admin_id in (select id from a)) select username from a;" \
              | "${COMPOSE[@]}" exec -T db psql -U invisen invisen -At -v u="$2" -v pw="$pw")
            [[ -n "$user" ]] || { echo "'$2' 계정이 없어요"; exit 1; }
            echo "$user 의 임시 비밀번호: $pw  (다음 로그인 때 새 비밀번호로 바꾸게 돼요)";;
  *) cat <<'HELP'
사용법: sudo invisen-admin <명령>
  status                 컨테이너 / 자동 배포 상태
  logs [줄수]            API 로그 보기
  restart                API 재시작 (/etc/invisen/api.env 를 바꾼 뒤)
  seed --me "이름:010…"  샘플 현장·구역·센서 + 내 계정 만들기 (DB 가 비어 있을 때만, 등록 코드 출력)
  invite 010… [시간]     작업자 로그인용 등록 코드 발급 (기본 72시간, 한 번만 사용)
  demo 010… on|off       가상 센서로 쓰는 계정으로 전환 (실제 센서 사양 전 테스트용)
  admin-password 아이디 [비밀번호]  관리자 대시보드 비밀번호 초기화 (비우면 임시 비밀번호 생성)
  psql                   DB 콘솔
  backup                 지금 DB 백업
HELP
  ;;
esac
SCRIPT
chmod 755 /usr/local/bin/invisen-admin

cat >/usr/local/bin/invisen-backup <<'SCRIPT'
#!/usr/bin/env bash
# DB 백업: /var/backups/invisen/invisen-YYYY-MM-DD.dump (14일 보관). 복구: pg_restore -c -d invisen
set -euo pipefail
out="/var/backups/invisen/invisen-$(date +%F).dump"
docker compose -f /opt/invisen/src/deploy/compose.yml --env-file /etc/invisen/compose.env exec -T db pg_dump -U invisen -Fc invisen >"$out.tmp"
mv "$out.tmp" "$out"
chmod 600 "$out"
find /var/backups/invisen -name 'invisen-*.dump' -mtime +14 -delete
echo "백업: $out"
SCRIPT
chmod 755 /usr/local/bin/invisen-backup

cat >/etc/systemd/system/invisen-deploy.service <<'UNIT'
[Unit]
Description=invisen: deploy new commits from the production branch
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/invisen-deploy --if-changed
TimeoutStartSec=30min
UNIT
cat >/etc/systemd/system/invisen-deploy.timer <<'UNIT'
[Unit]
Description=invisen: check for new deploys every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
UNIT
cat >/etc/systemd/system/invisen-backup.service <<'UNIT'
[Unit]
Description=invisen: nightly database backup
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/invisen-backup
UNIT
cat >/etc/systemd/system/invisen-backup.timer <<'UNIT'
[Unit]
Description=invisen: nightly database backup

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload

/usr/local/bin/invisen-deploy
systemctl enable --now invisen-deploy.timer invisen-backup.timer

# ---------------------------------------------------------------------------
log "8/9 웹 서버 (nginx) 설정"
CERT_DIR="/etc/letsencrypt/live/${DOMAIN:-none}"
grep -q '^\s*server_tokens off' /etc/nginx/nginx.conf || sed -i 's/^\(\s*\)# server_tokens off;/\1server_tokens off;/' /etc/nginx/nginx.conf
write_nginx

# ---------------------------------------------------------------------------
log "9/9 HTTPS"
if [[ -n "$DOMAIN" && -n "$EMAIL" ]]; then
  apt-get install -y certbot
  if [[ ! -f "$CERT_DIR/fullchain.pem" ]]; then
    if certbot certonly --webroot -w /var/www/letsencrypt -d "$DOMAIN" -m "$EMAIL" --agree-tos --non-interactive; then
      write_nginx
    else
      warn "인증서 발급 실패. 도메인 DNS 가 이 서버의 공인 IP 를 가리키는지, 80 포트가 열려 있는지 확인 후 다시 실행하세요."
    fi
  fi
  install -d /etc/letsencrypt/renewal-hooks/deploy
  printf '#!/bin/sh\nsystemctl reload nginx\n' >/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
  chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
elif [[ -n "$DOMAIN" ]]; then
  warn "EMAIL 이 없어 HTTPS 인증서는 건너뛰었습니다."
else
  echo "도메인이 없어 HTTP 로만 열었습니다. 도메인이 생기면 DOMAIN=… EMAIL=… 을 붙여 다시 실행하세요."
fi

log "완료"
local scheme=http
[[ -n "$DOMAIN" && -f "$CERT_DIR/fullchain.pem" ]] && scheme=https
echo "  앱:         $scheme://${DOMAIN:-<공인 IP>}/"
echo "  API 상태:   $scheme://${DOMAIN:-<공인 IP>}/api/health"
echo "  자동 배포:  production 브랜치를 1분마다 확인 (systemctl list-timers 'invisen-*')"
echo "  관리:       sudo invisen-admin help"
echo
echo "  처음이라면 내 계정 만들기:  sudo invisen-admin seed --me \"이름:010XXXXXXXX\""
echo "  다른 작업자 등록 코드:      sudo invisen-admin invite 010XXXXXXXX  (관리자 대시보드가 생기면 거기서 발급)"
echo
echo "  eney.cloud 콘솔의 [네트워크 › 방화벽 정책] 에서 22(내 IP만), 80, 443 인바운드가 열려 있어야 해요."
}

# nginx 설정 전체를 여기서 관리한다 (certbot 은 인증서만 발급, 설정 파일은 건드리지 않음).
write_nginx() {
  local v6_80="" v6_443="" hsts="" app_block tls_server=""
  if [[ -s /proc/net/if_inet6 ]]; then
    v6_80="listen [::]:80 default_server;"
    v6_443="listen [::]:443 ssl http2 default_server;"
  fi
  local have_cert=0
  [[ -n "$DOMAIN" && -f "$CERT_DIR/fullchain.pem" ]] && have_cert=1
  [[ $have_cert -eq 1 ]] && hsts='add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;'

  cat >/etc/nginx/snippets/invisen-security.conf <<CONF
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), payment=(), geolocation=(self)" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" always;
$hsts
CONF

  cat >/etc/nginx/snippets/invisen-app.conf <<CONF
root $WEB_ROOT/current;
index index.html;
client_max_body_size 1m;
gzip on;
gzip_types text/css application/javascript image/svg+xml application/json;
include snippets/invisen-security.conf;

location /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 30s;
}

# 해시가 붙은 빌드 파일은 오래 캐시
location /assets/ {
    include snippets/invisen-security.conf;
    add_header Cache-Control "public, max-age=31536000, immutable";
    try_files \$uri =404;
}

# index.html 은 항상 새로 받아 배포가 바로 반영되게 (앱 + 관리자 대시보드 /admin/)
location = /index.html {
    include snippets/invisen-security.conf;
    add_header Cache-Control "no-cache";
}
location = /admin/index.html {
    include snippets/invisen-security.conf;
    add_header Cache-Control "no-cache";
}

location ~ /\.(?!well-known/) { deny all; }

location / {
    try_files \$uri \$uri/ /index.html;
}
CONF

  if [[ $have_cert -eq 1 ]]; then
    app_block="location / { return 301 https://\$host\$request_uri; }"
    tls_server="server {
    listen 443 ssl http2 default_server;
    $v6_443
    server_name $DOMAIN;
    server_tokens off;
    ssl_certificate $CERT_DIR/fullchain.pem;
    ssl_certificate_key $CERT_DIR/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:invisen:10m;
    ssl_session_timeout 1d;
    include snippets/invisen-app.conf;
}"
  else
    app_block="include snippets/invisen-app.conf;"
  fi

  cat >/etc/nginx/sites-available/invisen <<CONF
server {
    listen 80 default_server;
    $v6_80
    server_name ${DOMAIN:-_};
    server_tokens off;

    # Let's Encrypt 인증 파일
    location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; }

    $app_block
}

$tls_server
CONF
  rm -f /etc/nginx/sites-enabled/default
  ln -sfn /etc/nginx/sites-available/invisen /etc/nginx/sites-enabled/invisen
  nginx -t
  systemctl enable nginx
  systemctl reload nginx || systemctl restart nginx
}

# 스크립트 전체를 읽은 뒤 실행 (curl | bash 중 다른 명령이 stdin 을 먹지 않게)
main "$@"

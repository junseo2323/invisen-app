#!/usr/bin/env bash
# invisen 서버 초기 설정 + 보안 설정 + 웹앱 배포 (Ubuntu 22.04, eney.cloud 인스턴스)
#
#   curl -fsSL https://raw.githubusercontent.com/junseo2323/invisen-app/<branch>/deploy/setup.sh | sudo bash
#
# 옵션 (환경변수, sudo 뒤에 붙여서: curl … | sudo DOMAIN=app.example.com EMAIL=me@example.com bash)
#   DOMAIN          앱 도메인. 있으면 Let's Encrypt HTTPS + HSTS 를 켭니다.
#   EMAIL           Let's Encrypt 연락처 (DOMAIN 과 함께).
#   SSH_ALLOW_FROM  SSH 를 허용할 IP/CIDR (예: 203.0.113.7/32). 비우면 어디서나(속도 제한 적용).
#   REPO_URL, REF   배포할 저장소와 브랜치 (기본: junseo2323/invisen-app, main)
#
# 여러 번 실행해도 안전합니다. 앱만 다시 배포하려면: sudo invisen-deploy
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/junseo2323/invisen-app.git}"
REF="${REF:-main}"
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
log "1/8 패키지 업데이트, 기본 도구 설치"
apt-get update -y
apt-get -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade -y
apt-get install -y ca-certificates curl git gnupg ufw fail2ban unattended-upgrades nginx rsync
timedatectl set-timezone Asia/Seoul || true

if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1)" != "v22" ]]; then
  log "Node.js 22 설치"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# ---------------------------------------------------------------------------
log "2/8 자동 보안 업데이트"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now unattended-upgrades

# ---------------------------------------------------------------------------
log "3/8 SSH 잠금 (키 로그인만, root 로그인 금지)"
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
  cat >/etc/ssh/sshd_config.d/00-invisen-hardening.conf <<EOF
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
EOF
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
log "4/8 방화벽 (ufw): SSH, HTTP, HTTPS 만 허용"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
if [[ -n "$SSH_ALLOW_FROM" ]]; then
  ufw allow from "$SSH_ALLOW_FROM" to any port 22 proto tcp comment 'ssh (admin)'
else
  ufw limit 22/tcp comment 'ssh (rate limited)'
fi
ufw allow 80/tcp comment 'http'
ufw allow 443/tcp comment 'https'
ufw --force enable

log "5/8 무차별 대입 차단 (fail2ban)"
cat >/etc/fail2ban/jail.d/invisen.local <<'EOF'
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5
backend = systemd

[sshd]
enabled = true
EOF
systemctl enable fail2ban
systemctl restart fail2ban

log "6/8 커널 네트워크 보안 설정"
cat >/etc/sysctl.d/90-invisen.conf <<'EOF'
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
EOF
sysctl --system >/dev/null

# ---------------------------------------------------------------------------
log "7/8 앱 배포 (빌드 전용 계정 $APP_USER, 릴리스 단위 교체)"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$WEB_ROOT/releases"

cat >/usr/local/bin/invisen-deploy <<EOF
#!/usr/bin/env bash
# 저장소에서 받아 빌드하고 새 릴리스로 교체한다. 실패하면 지금 버전이 그대로 남는다.
set -euo pipefail
REPO_URL="\${REPO_URL:-$REPO_URL}"
REF="\${REF:-$REF}"
SRC="$APP_HOME/src"
if [[ ! -d "\$SRC/.git" ]]; then
  sudo -u $APP_USER git clone --depth 1 --branch "\$REF" "\$REPO_URL" "\$SRC"
else
  sudo -u $APP_USER git -C "\$SRC" fetch --depth 1 origin "\$REF"
  sudo -u $APP_USER git -C "\$SRC" reset --hard FETCH_HEAD
fi
cd "\$SRC"
sudo -u $APP_USER -H npm ci --no-audit --no-fund
sudo -u $APP_USER -H npm run build
REL="$WEB_ROOT/releases/\$(date +%Y%m%d-%H%M%S)-\$(sudo -u $APP_USER git -C "\$SRC" rev-parse --short HEAD)"
mkdir -p "\$REL"
rsync -a --delete "\$SRC/dist/" "\$REL/"
chown -R root:root "\$REL"
chmod -R a+rX,go-w "\$REL"
ln -sfn "\$REL" "$WEB_ROOT/current.tmp"
mv -Tf "$WEB_ROOT/current.tmp" "$WEB_ROOT/current"
# 최근 5개 릴리스만 남김 (되돌리기: ln -sfn <이전 릴리스> $WEB_ROOT/current)
ls -1dt $WEB_ROOT/releases/* | tail -n +6 | xargs -r rm -rf
echo "배포 완료: \$REL"
EOF
chmod 755 /usr/local/bin/invisen-deploy
/usr/local/bin/invisen-deploy

# ---------------------------------------------------------------------------
log "8/8 웹 서버 (nginx) 설정"
SERVER_NAME="${DOMAIN:-_}"
LISTEN_V6=""
[[ -s /proc/net/if_inet6 ]] && LISTEN_V6="listen [::]:80 default_server;"
HSTS=""
[[ -n "$DOMAIN" ]] && HSTS='add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;'

cat >/etc/nginx/snippets/invisen-security.conf <<EOF
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), payment=(), geolocation=(self)" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" always;
$HSTS
EOF

cat >/etc/nginx/sites-available/invisen <<EOF
server {
    listen 80 default_server;
    $LISTEN_V6
    server_name $SERVER_NAME;

    root $WEB_ROOT/current;
    index index.html;
    server_tokens off;
    client_max_body_size 1m;

    gzip on;
    gzip_types text/css application/javascript image/svg+xml application/json;

    include snippets/invisen-security.conf;

    # 해시가 붙은 빌드 파일은 오래 캐시
    location /assets/ {
        include snippets/invisen-security.conf;
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files \$uri =404;
    }

    # index.html 은 항상 새로 받아 배포가 바로 반영되게
    location = /index.html {
        include snippets/invisen-security.conf;
        add_header Cache-Control "no-cache";
    }

    location ~ /\.(?!well-known/) { deny all; }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF
rm -f /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/invisen /etc/nginx/sites-enabled/invisen
grep -q '^\s*server_tokens off' /etc/nginx/nginx.conf || sed -i 's/^\(\s*\)# server_tokens off;/\1server_tokens off;/' /etc/nginx/nginx.conf
nginx -t
systemctl enable nginx
systemctl reload nginx || systemctl restart nginx

if [[ -n "$DOMAIN" && -n "$EMAIL" ]]; then
  log "HTTPS 인증서 발급 ($DOMAIN)"
  apt-get install -y certbot python3-certbot-nginx
  if certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --redirect --non-interactive; then
    systemctl reload nginx
  else
    warn "인증서 발급 실패. 도메인 DNS 가 이 서버의 공인 IP 를 가리키는지, 80 포트가 열려 있는지 확인 후 다시 실행하세요."
  fi
elif [[ -n "$DOMAIN" ]]; then
  warn "EMAIL 이 없어 HTTPS 인증서는 건너뛰었습니다."
fi

log "완료"
echo "  앱:       http://${DOMAIN:-<공인 IP>}/  (DOMAIN+EMAIL 을 주면 https)"
echo "  재배포:   sudo invisen-deploy"
echo "  방화벽:   sudo ufw status verbose"
echo "  차단 현황: sudo fail2ban-client status sshd"
echo
echo "  eney.cloud 콘솔의 [네트워크 › 방화벽 정책] 에서도 22(내 IP만), 80, 443 인바운드를 열어야 외부에서 접속됩니다."
}

# 스크립트 전체를 읽은 뒤 실행 (curl | bash 중 다른 명령이 stdin 을 먹지 않게)
main "$@"

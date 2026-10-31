#!/usr/bin/env bash
#
# 会规化会务执行系统 —— 阿里云 ECS 部署脚本（生产 / 云服务器测试双模式）
#
# 幂等：重复执行只更新代码与配置，不动已有数据库、附件和密钥。
#
# 生产模式（默认）：
#   sudo ./deploy.sh --domain erp-prod.example.com --admin-phone 13800000000 \
#        --email ops@example.com
#   要求域名已备案并解析到本机；自动签发 Let's Encrypt 证书，监听 80/443。
#
# 测试模式（--test）：
#   sudo ./deploy.sh --test --admin-phone 13800000000
#   面向「域名未备案、短信未开通」阶段：纯 HTTP 监听 8080，用 IP 直接访问；
#   验证码走 console 通道写入服务器日志，不发真实短信。
#   与生产完全隔离：独立代码目录 /opt/erp-test、数据库 /var/lib/erp-test、端口 8788。
#
# 短信凭据通过环境变量传入，不落命令行历史。生产默认 ERP_SMS_PROVIDER=aliyun：
#   阿里云：ERP_ALIYUN_SMS_ACCESS_KEY_ID / ERP_ALIYUN_SMS_ACCESS_KEY_SECRET
#           ERP_ALIYUN_SMS_SIGN_NAME / ERP_ALIYUN_SMS_TEMPLATE_CODE
#   腾讯云：ERP_SMS_PROVIDER=tencent + ERP_TENCENT_*（保留兼容）
#   测试模式默认 console，无需任何短信凭据；可选 ERP_TEST_FIXED_SMS_CODE=654321。
#
# 首次执行会生成 ERP_SECRET 并写入环境文件（0640）。已存在时保留原有密钥，不覆盖。
#
set -Eeuo pipefail

MODE="prod"
REPO_URL="${ERP_REPO_URL:-https://github.com/keyneszeng/erp-workbanch.git}"
REF="${ERP_REF:-main}"
CONF_DIR="/etc/erp-workbanch"
SERVICE_USER="erp"
DOMAIN=""
ADMIN_PHONE=""
ACME_EMAIL=""
SKIP_TLS=0
DRY_RUN=0

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = "1" ]; then printf '    + %s\n' "$*"; else "$@"; fi; }

# 阿里云等云镜像会把 nginx.service 软链到 /dev/null（masked），
# 此时 systemctl reload/start 直接报 "Unit nginx.service is masked" 而失败。
# 先解除 mask 并确保进程在跑，再做 reload。
ensure_nginx() {
  if ! systemctl is-enabled nginx >/dev/null 2>&1; then
    systemctl unmask nginx.service >/dev/null 2>&1 || true
    systemctl enable nginx >/dev/null 2>&1 || true
  fi
  systemctl is-active nginx >/dev/null 2>&1 || systemctl start nginx
}

usage() {
  awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --test)        MODE="test"; shift ;;
    --domain)      DOMAIN="${2:-}"; shift 2 ;;
    --admin-phone) ADMIN_PHONE="${2:-}"; shift 2 ;;
    --email)       ACME_EMAIL="${2:-}"; shift 2 ;;
    --ref)         REF="${2:-}"; shift 2 ;;
    --skip-tls)    SKIP_TLS=1; shift ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)     usage 0 ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

# ---------- 模式派生 ----------
if [ "$MODE" = "test" ]; then
  APP_ROOT="/opt/erp-test"
  DATA_ROOT="/var/lib/erp-test"
  ENV_FILE="${CONF_DIR}/test.env"
  SERVICE="erp-test"
  APP_PORT=8788
  NGINX_PORT=8080
  GATE="check-aliyun-test.cjs"
  UNIT_FILE="erp-test.service"
  SITE_NAME="erp-test"
  DEPLOY_TARGET="aliyun-ecs-test"
  BACKUP_UNIT="erp-test-backup"
  DEFAULT_SMS="console"
  SKIP_TLS=1
else
  APP_ROOT="/opt/erp-workbanch"
  DATA_ROOT="/var/lib/erp"
  ENV_FILE="${CONF_DIR}/production.env"
  SERVICE="erp"
  APP_PORT=8787
  NGINX_PORT=443
  GATE="check-aliyun-production.cjs"
  UNIT_FILE="erp.service"
  SITE_NAME="erp"
  DEPLOY_TARGET="aliyun-ecs"
  BACKUP_UNIT="erp-backup"
  DEFAULT_SMS="aliyun"
fi

# ---------- 前置校验 ----------
[ "$(id -u)" -eq 0 ] || die "请用 root 执行（sudo -i 后重跑）"
[ -n "$ADMIN_PHONE" ] || die "缺少 --admin-phone（总管理员手机号，首次初始化用）"
printf '%s' "$ADMIN_PHONE" | grep -Eq '^1[3-9][0-9]{9}$' \
  || die "手机号必须是有效的中国大陆 11 位号码：$ADMIN_PHONE"

if [ -n "$DOMAIN" ]; then
  case "$DOMAIN" in
    erp.aibuild.work) die "erp.aibuild.work 是 Cloudflare 演示版，不得占用" ;;
  esac
  printf '%s' "$DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' \
    || die "域名格式不正确：$DOMAIN"
elif [ "$MODE" = "prod" ]; then
  die "生产模式缺少 --domain（测试环境可用 --test 免域名）"
fi

SMS_PROVIDER="${ERP_SMS_PROVIDER:-$DEFAULT_SMS}"
case "$SMS_PROVIDER" in
  console)
    [ "$MODE" = "test" ] || die "console 短信通道只允许测试模式使用（生产会拒绝启动）"
    ;;
  aliyun)
    for v in ERP_ALIYUN_SMS_ACCESS_KEY_ID ERP_ALIYUN_SMS_ACCESS_KEY_SECRET \
             ERP_ALIYUN_SMS_SIGN_NAME ERP_ALIYUN_SMS_TEMPLATE_CODE; do
      [ -n "${!v:-}" ] || die "缺少环境变量 $v（阿里云短信，必填）"
    done
    ;;
  tencent)
    for v in ERP_TENCENT_SECRET_ID ERP_TENCENT_SECRET_KEY ERP_TENCENT_SMS_APP_ID \
             ERP_TENCENT_SMS_SIGN ERP_TENCENT_SMS_TEMPLATE_ID; do
      [ -n "${!v:-}" ] || die "缺少环境变量 $v（腾讯云短信，必填）"
    done
    ;;
  *) die "ERP_SMS_PROVIDER 只能是 console / aliyun / tencent，当前：$SMS_PROVIDER" ;;
esac

FIXED_CODE="${ERP_TEST_FIXED_SMS_CODE:-}"
if [ -n "$FIXED_CODE" ]; then
  [ "$MODE" = "test" ] || die "ERP_TEST_FIXED_SMS_CODE 只允许测试模式使用"
  printf '%s' "$FIXED_CODE" | grep -Eq '^[0-9]{6}$' || die "ERP_TEST_FIXED_SMS_CODE 必须是 6 位数字"
  [ "$SMS_PROVIDER" = "console" ] || die "ERP_TEST_FIXED_SMS_CODE 仅可与 console 通道同时使用"
fi

if [ "$MODE" = "prod" ] && [ "$SKIP_TLS" = "0" ]; then
  [ -n "$ACME_EMAIL" ] || die "签发证书需要 --email（或加 --skip-tls 先不配 HTTPS）"
fi

# ---------- 系统依赖 ----------
log "检查操作系统与软件源（模式：$MODE）"
. /etc/os-release 2>/dev/null || die "无法读取 /etc/os-release"
case "${ID:-}" in
  ubuntu|debian) ;;
  *) die "仅支持 Ubuntu / Debian，当前：${PRETTY_NAME:-$ID}" ;;
esac

log "更新软件包索引"
run apt-get update -qq
run apt-get install -y -qq curl ca-certificates gnupg

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 22 ]; then
  log "安装 Node.js 22（NodeSource）"
  if [ "$DRY_RUN" = "0" ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -qq nodejs
  fi
fi
NODE_BIN="$(command -v node || echo /usr/bin/node)"
if [ "$DRY_RUN" = "0" ]; then
  [ -x "$NODE_BIN" ] || die "Node 未安装成功"
  log "Node 版本：$("$NODE_BIN" -v)"
fi

log "安装 Nginx / sqlite3 / git / rsync"
run apt-get install -y -qq nginx sqlite3 git rsync
if [ "$MODE" = "prod" ]; then
  run apt-get install -y -qq certbot python3-certbot-nginx
fi

# ---------- 服务账户与目录 ----------
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  log "创建服务账户 $SERVICE_USER"
  run useradd --system --home-dir "$APP_ROOT" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

log "准备目录（$DATA_ROOT）"
run install -d -m 0755 "$APP_ROOT" "$APP_ROOT/releases"
run install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_ROOT"
run install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_ROOT/uploads"
run install -d -m 0700 "$DATA_ROOT/backup"
run install -d -m 0750 -o root -g "$SERVICE_USER" "$CONF_DIR"

# ---------- 代码 ----------
STAMP="$(date +%Y%m%d%H%M%S)"
RELEASE_DIR="$APP_ROOT/releases/$STAMP"
log "拉取代码：$REPO_URL @ $REF → $RELEASE_DIR"
run git clone --quiet --depth 1 --branch "$REF" "$REPO_URL" "$RELEASE_DIR"
if [ "$DRY_RUN" = "0" ]; then
  git -C "$RELEASE_DIR" rev-parse --short HEAD > "$RELEASE_DIR/.revision"
  log "代码版本：$(cat "$RELEASE_DIR/.revision")"
fi

log "安装生产依赖"
# 仓库未跟踪 package-lock.json，此时 npm ci 会直接失败，回退到 npm install。
# 依赖版本在 package.json 里是精确锁定的（pdf-lib 1.17.1），install 结果同样确定。
if [ "$DRY_RUN" = "0" ]; then
  if [ -f "$RELEASE_DIR/package-lock.json" ]; then
    ( cd "$RELEASE_DIR" && npm ci --omit=dev --no-audit --no-fund )
  else
    ( cd "$RELEASE_DIR" && npm install --omit=dev --no-audit --no-fund )
  fi
  chown -R root:"$SERVICE_USER" "$RELEASE_DIR"
  chmod -R g+rX "$RELEASE_DIR"
fi

# ---------- 环境变量 ----------
if [ -f "$ENV_FILE" ]; then
  log "保留已有 $ENV_FILE（不覆盖密钥与短信配置）"
else
  log "生成 $ENV_FILE"
  GEN_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  if [ "$DRY_RUN" = "1" ]; then
    printf '    + 写入 %s（含新生成的 ERP_SECRET）\n' "$ENV_FILE"
  else
    umask 077
    {
      printf '# 由 deploy.sh 生成于 %s（模式 %s）。禁止提交到 Git。\n' "$(date -Iseconds)" "$MODE"
      printf 'NODE_ENV=production\n'
      printf 'ERP_DEPLOY_TARGET=%s\n' "$DEPLOY_TARGET"
      printf 'ERP_DEMO_MODE=0\n'
      printf 'ERP_PRODUCTION_DOMAIN=%s\n' "$DOMAIN"
      printf 'ERP_BOOTSTRAP_ADMIN_PHONE=%s\n' "$ADMIN_PHONE"
      printf 'ERP_DB=%s/erp.db\n' "$DATA_ROOT"
      printf 'ERP_UPLOAD_DIR=%s/uploads\n' "$DATA_ROOT"
      printf 'ERP_HOST=127.0.0.1\n'
      printf 'ERP_PORT=%s\n' "$APP_PORT"
      printf 'ERP_TRUST_PROXY=1\n'
      printf 'ERP_SESSION_FALLBACK=0\n'
      printf 'ERP_SECRET=%s\n' "$GEN_SECRET"
      printf 'ERP_SMS_PROVIDER=%s\n' "$SMS_PROVIDER"
      case "$SMS_PROVIDER" in
        console) printf 'ERP_TEST_FIXED_SMS_CODE=%s\n' "$FIXED_CODE" ;;
        aliyun)
          printf 'ERP_ALIYUN_SMS_ACCESS_KEY_ID=%s\n' "$ERP_ALIYUN_SMS_ACCESS_KEY_ID"
          printf 'ERP_ALIYUN_SMS_ACCESS_KEY_SECRET=%s\n' "$ERP_ALIYUN_SMS_ACCESS_KEY_SECRET"
          printf 'ERP_ALIYUN_SMS_SIGN_NAME=%s\n' "$ERP_ALIYUN_SMS_SIGN_NAME"
          printf 'ERP_ALIYUN_SMS_TEMPLATE_CODE=%s\n' "$ERP_ALIYUN_SMS_TEMPLATE_CODE"
          printf 'ERP_ALIYUN_SMS_REGION=%s\n' "${ERP_ALIYUN_SMS_REGION:-cn-hangzhou}"
          ;;
        tencent)
          printf 'ERP_TENCENT_SECRET_ID=%s\n' "$ERP_TENCENT_SECRET_ID"
          printf 'ERP_TENCENT_SECRET_KEY=%s\n' "$ERP_TENCENT_SECRET_KEY"
          printf 'ERP_TENCENT_SMS_APP_ID=%s\n' "$ERP_TENCENT_SMS_APP_ID"
          printf 'ERP_TENCENT_SMS_SIGN=%s\n' "$ERP_TENCENT_SMS_SIGN"
          printf 'ERP_TENCENT_SMS_TEMPLATE_ID=%s\n' "$ERP_TENCENT_SMS_TEMPLATE_ID"
          printf 'ERP_TENCENT_SMS_REGION=%s\n' "${ERP_TENCENT_SMS_REGION:-ap-guangzhou}"
          ;;
      esac
      printf 'ERP_MINIPROGRAM_ENABLED=%s\n' "${ERP_MINIPROGRAM_ENABLED:-0}"
      printf 'ERP_WECHAT_APP_ID=%s\n' "${ERP_WECHAT_APP_ID:-}"
      printf 'ERP_WECHAT_APP_SECRET=%s\n' "${ERP_WECHAT_APP_SECRET:-}"
    } > "$ENV_FILE"
    chown root:"$SERVICE_USER" "$ENV_FILE"
    chmod 0640 "$ENV_FILE"
  fi
fi

# ---------- 切换版本 ----------
log "切换 current → $STAMP"
if [ "$DRY_RUN" = "0" ]; then
  ln -sfn "$RELEASE_DIR" "$APP_ROOT/current.next"
  mv -Tf "$APP_ROOT/current.next" "$APP_ROOT/current"
fi

# ---------- 环境预检 ----------
log "执行环境预检（$GATE，fail closed）"
if [ "$DRY_RUN" = "0" ]; then
  set -a; . "$ENV_FILE"; set +a
  if ! "$NODE_BIN" "$APP_ROOT/current/scripts/$GATE"; then
    die "预检未通过，未启动服务。修正 $ENV_FILE 后重跑。"
  fi
fi

# ---------- systemd ----------
log "安装 systemd 单元（$UNIT_FILE）"
UNIT_SRC="$APP_ROOT/current/deploy/aliyun/$UNIT_FILE"
[ "$DRY_RUN" = "1" ] || [ -f "$UNIT_SRC" ] || die "缺少 $UNIT_SRC"
if [ "$DRY_RUN" = "0" ]; then
  sed "s#/usr/bin/node#${NODE_BIN}#g" "$UNIT_SRC" > "/etc/systemd/system/$UNIT_FILE"
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null
fi

# ---------- Nginx ----------
SITE_AVAIL="/etc/nginx/sites-available/${SITE_NAME}.conf"
SITE_ENABLED="/etc/nginx/sites-enabled/${SITE_NAME}.conf"

if [ "$MODE" = "test" ]; then
  # 测试环境：纯 HTTP + 8080，直接吃 IP 访问，不碰 80/443（未备案会被拦）
  log "配置 Nginx（$NGINX_PORT，纯 HTTP，无需备案）"
  if [ "$DRY_RUN" = "0" ]; then
    install -m 0644 "$APP_ROOT/current/deploy/aliyun/nginx-erp-test.conf.example" "$SITE_AVAIL"
    ln -sfn "$SITE_AVAIL" "$SITE_ENABLED"
    rm -f /etc/nginx/sites-enabled/default
    nginx -t
    ensure_nginx
    systemctl reload nginx
  fi
else
  # 生产：证书不存在时先起纯 HTTP，交给 certbot 签发并改写，避免 nginx -t 失败
  CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
  log "配置 Nginx（$DOMAIN）"
  if [ "$DRY_RUN" = "0" ]; then
    if [ -f "$CERT_DIR/fullchain.pem" ]; then
      install -m 0644 "$APP_ROOT/current/deploy/aliyun/nginx-erp.conf.example" "$SITE_AVAIL"
      sed -i "s/production\.example\.com/${DOMAIN}/g" "$SITE_AVAIL"
    else
      cat > "$SITE_AVAIL" <<NGINX
# 由 deploy.sh 生成：先 HTTP，待 certbot 签发后自动改写为 HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    client_max_body_size 12m;

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 10s;
        proxy_read_timeout 90s;
    }
}
NGINX
    fi
    ln -sfn "$SITE_AVAIL" "$SITE_ENABLED"
    rm -f /etc/nginx/sites-enabled/default
    nginx -t
    ensure_nginx
    systemctl reload nginx
  fi

  if [ "$SKIP_TLS" = "0" ]; then
    if [ -f "$CERT_DIR/fullchain.pem" ] && [ "$DRY_RUN" = "0" ]; then
      log "证书已存在，跳过签发"
    else
      log "申请 Let's Encrypt 证书（需要 $DOMAIN 已解析到本机且 80 端口放通）"
      if [ "$DRY_RUN" = "0" ]; then
        certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$ACME_EMAIL" --redirect \
          || die "证书签发失败：确认 $DOMAIN 的 A 记录已指向本机、安全组放通 80/443 后重跑"
        nginx -t && { ensure_nginx; systemctl reload nginx; }
      fi
    fi
  else
    warn "已跳过 TLS。上线前必须补证书，否则浏览器会拦。"
  fi
fi

# ---------- 启动 ----------
log "启动服务"
run systemctl restart "$SERVICE"

if [ "$DRY_RUN" = "0" ]; then
  for i in $(seq 1 60); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null 2>&1; then
      log "健康检查通过：http://127.0.0.1:${APP_PORT}/api/health"
      break
    fi
    [ "$i" -eq 60 ] && { journalctl -u "$SERVICE" -n 40 --no-pager; die "服务未在 60 秒内就绪"; }
    sleep 1
  done
fi

# ---------- 备份 ----------
log "安装每日备份（sqlite3 .backup，保留 30 天）"
if [ "$DRY_RUN" = "0" ]; then
  cat > "/usr/local/sbin/${BACKUP_UNIT}" <<BACKUP
#!/usr/bin/env bash
set -Eeuo pipefail
DB=${DATA_ROOT}/erp.db
OUT=${DATA_ROOT}/backup
STAMP=\$(date +%Y%m%d-%H%M%S)
[ -f "\$DB" ] || exit 0
sqlite3 "\$DB" ".backup '\$OUT/erp-\$STAMP.db'"
rsync -a --delete ${DATA_ROOT}/uploads/ "\$OUT/uploads-current/"
gzip -f "\$OUT/erp-\$STAMP.db"
find "\$OUT" -name 'erp-*.db.gz' -mtime +30 -delete
BACKUP
  chmod 0750 "/usr/local/sbin/${BACKUP_UNIT}"
  cat > "/etc/systemd/system/${BACKUP_UNIT}.service" <<UNIT
[Unit]
Description=ERP SQLite backup (${MODE})
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/${BACKUP_UNIT}
UNIT
  cat > "/etc/systemd/system/${BACKUP_UNIT}.timer" <<UNIT
[Unit]
Description=Daily ERP backup (${MODE})
[Timer]
OnCalendar=*-*-* 03:20:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now "${BACKUP_UNIT}.timer" >/dev/null
fi

# ---------- 完成 ----------
PUBLIC_HINT="https://${DOMAIN}"
[ "$MODE" = "test" ] && PUBLIC_HINT="http://<ECS公网IP>:${NGINX_PORT}（安全组需放通 ${NGINX_PORT}）"

cat <<EOF

────────────────────────────────────────────────────────
 部署完成（$MODE）
────────────────────────────────────────────────────────
 访问        ${PUBLIC_HINT}
 服务        systemctl status ${SERVICE}
 日志        journalctl -u ${SERVICE} -f
 配置        ${ENV_FILE}（0640，含 ERP_SECRET）
 数据        ${DATA_ROOT}/erp.db   附件 ${DATA_ROOT}/uploads
 备份        ${DATA_ROOT}/backup（每日 03:20，保留 30 天）
 回滚        ln -sfn ${APP_ROOT}/releases/<旧版本> ${APP_ROOT}/current && systemctl restart ${SERVICE}

 首次登录    手机号 ${ADMIN_PHONE} / 密码 123456
EOF

if [ "$MODE" = "test" ]; then
cat <<EOF

 验证码      短信通道 ${SMS_PROVIDER}，不真实发送。
             查看：journalctl -u ${SERVICE} | grep SMS-CONSOLE
EOF
  if [ -n "$FIXED_CODE" ]; then
    printf '             或直接使用固定验证码 %s\n' "$FIXED_CODE"
  fi
cat <<EOF

 注意        本环境仅供功能验证，禁止录入真实业务数据。
             域名备案与短信审核通过后，用生产模式重新部署，两者互不影响。
────────────────────────────────────────────────────────
EOF
else
cat <<EOF

 提示        登录后必须先用短信验证码改密，短信通道不通则无法进入业务。
────────────────────────────────────────────────────────
EOF
fi

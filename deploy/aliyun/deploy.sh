#!/usr/bin/env bash
#
# 会规化会务执行系统 —— 阿里云 ECS 生产部署脚本
#
# 幂等：重复执行只更新代码与配置，不动已有数据库、附件和密钥。
# 前置检查与 systemd / Nginx 模板保持一致（见 docs/production-deployment.md）。
#
# 用法：
#   sudo ./deploy.sh --domain erp-prod.example.com --admin-phone 13800000000 \
#        --email ops@example.com
#
# 短信凭据通过环境变量传入，不落命令行历史。默认 ERP_SMS_PROVIDER=aliyun：
#   阿里云：ERP_ALIYUN_SMS_ACCESS_KEY_ID / ERP_ALIYUN_SMS_ACCESS_KEY_SECRET
#           ERP_ALIYUN_SMS_SIGN_NAME / ERP_ALIYUN_SMS_TEMPLATE_CODE
#   腾讯云：ERP_SMS_PROVIDER=tencent + ERP_TENCENT_*（保留兼容）
#
# 首次执行会生成 ERP_SECRET 并写入 /etc/erp-workbanch/production.env（0600）。
# 已存在该文件时保留原有密钥，不覆盖。
#
set -Eeuo pipefail

REPO_URL="${ERP_REPO_URL:-https://github.com/keyneszeng/erp-workbanch.git}"
REF="${ERP_REF:-main}"
APP_ROOT="/opt/erp-workbanch"
DATA_ROOT="/var/lib/erp"
CONF_DIR="/etc/erp-workbanch"
ENV_FILE="${CONF_DIR}/production.env"
SERVICE="erp"
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

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
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

# ---------- 前置校验 ----------
[ "$(id -u)" -eq 0 ] || die "请用 root 执行（sudo -i 后重跑）"
[ -n "$DOMAIN" ] || die "缺少 --domain"
[ -n "$ADMIN_PHONE" ] || die "缺少 --admin-phone（总管理员手机号，首次初始化用）"

case "$DOMAIN" in
  erp.aibuild.work) die "erp.aibuild.work 永远是演示版，不得作为生产域名" ;;
esac
printf '%s' "$DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' \
  || die "域名格式不正确：$DOMAIN"
printf '%s' "$ADMIN_PHONE" | grep -Eq '^1[3-9][0-9]{9}$' \
  || die "手机号必须是有效的中国大陆 11 位号码：$ADMIN_PHONE"

SMS_PROVIDER="${ERP_SMS_PROVIDER:-aliyun}"
case "$SMS_PROVIDER" in
  aliyun)
    for v in ERP_ALIYUN_SMS_ACCESS_KEY_ID ERP_ALIYUN_SMS_ACCESS_KEY_SECRET \
             ERP_ALIYUN_SMS_SIGN_NAME ERP_ALIYUN_SMS_TEMPLATE_CODE; do
      [ -n "${!v:-}" ] || die "缺少环境变量 $v（阿里云短信，生产环境必填）"
    done
    ;;
  tencent)
    for v in ERP_TENCENT_SECRET_ID ERP_TENCENT_SECRET_KEY ERP_TENCENT_SMS_APP_ID \
             ERP_TENCENT_SMS_SIGN ERP_TENCENT_SMS_TEMPLATE_ID; do
      [ -n "${!v:-}" ] || die "缺少环境变量 $v（腾讯云短信，生产环境必填）"
    done
    ;;
  *) die "ERP_SMS_PROVIDER 只能是 aliyun 或 tencent，当前：$SMS_PROVIDER" ;;
esac

if [ "$SKIP_TLS" = "0" ]; then
  [ -n "$ACME_EMAIL" ] || die "签发证书需要 --email（或加 --skip-tls 先不配 HTTPS）"
fi

# ---------- 系统依赖 ----------
log "检查操作系统与软件源"
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

log "安装 Nginx / certbot / sqlite3 / git"
run apt-get install -y -qq nginx sqlite3 git rsync certbot python3-certbot-nginx

# ---------- 服务账户与目录 ----------
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  log "创建服务账户 $SERVICE_USER"
  run useradd --system --home-dir "$APP_ROOT" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

log "准备目录"
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
fi
if [ "$DRY_RUN" = "0" ]; then
  chown -R root:"$SERVICE_USER" "$RELEASE_DIR"
  chmod -R g+rX "$RELEASE_DIR"
fi

# ---------- 生产环境变量 ----------
if [ -f "$ENV_FILE" ]; then
  log "保留已有 $ENV_FILE（不覆盖密钥与短信配置）"
else
  log "生成 $ENV_FILE"
  GEN_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  if [ "$DRY_RUN" = "1" ]; then
    printf '    + 写入 %s（含新生成的 ERP_SECRET）\n' "$ENV_FILE"
  else
    umask 077
    cat > "$ENV_FILE" <<EOF
# 由 deploy.sh 生成于 $(date -Iseconds)。禁止提交到 Git。
NODE_ENV=production
ERP_DEPLOY_TARGET=aliyun-ecs
ERP_DEMO_MODE=0
ERP_PRODUCTION_DOMAIN=${DOMAIN}
ERP_BOOTSTRAP_ADMIN_PHONE=${ADMIN_PHONE}
ERP_DB=${DATA_ROOT}/erp.db
ERP_UPLOAD_DIR=${DATA_ROOT}/uploads
ERP_HOST=127.0.0.1
ERP_PORT=8787
ERP_TRUST_PROXY=1
ERP_SESSION_FALLBACK=0
ERP_SECRET=${GEN_SECRET}
ERP_SMS_PROVIDER=${SMS_PROVIDER}
EOF
    if [ "$SMS_PROVIDER" = "aliyun" ]; then
      cat >> "$ENV_FILE" <<EOF
ERP_ALIYUN_SMS_ACCESS_KEY_ID=${ERP_ALIYUN_SMS_ACCESS_KEY_ID}
ERP_ALIYUN_SMS_ACCESS_KEY_SECRET=${ERP_ALIYUN_SMS_ACCESS_KEY_SECRET}
ERP_ALIYUN_SMS_SIGN_NAME=${ERP_ALIYUN_SMS_SIGN_NAME}
ERP_ALIYUN_SMS_TEMPLATE_CODE=${ERP_ALIYUN_SMS_TEMPLATE_CODE}
ERP_ALIYUN_SMS_REGION=${ERP_ALIYUN_SMS_REGION:-cn-hangzhou}
EOF
    else
      cat >> "$ENV_FILE" <<EOF
ERP_TENCENT_SECRET_ID=${ERP_TENCENT_SECRET_ID}
ERP_TENCENT_SECRET_KEY=${ERP_TENCENT_SECRET_KEY}
ERP_TENCENT_SMS_APP_ID=${ERP_TENCENT_SMS_APP_ID}
ERP_TENCENT_SMS_SIGN=${ERP_TENCENT_SMS_SIGN}
ERP_TENCENT_SMS_TEMPLATE_ID=${ERP_TENCENT_SMS_TEMPLATE_ID}
ERP_TENCENT_SMS_REGION=${ERP_TENCENT_SMS_REGION:-ap-guangzhou}
EOF
    fi
    cat >> "$ENV_FILE" <<EOF
ERP_MINIPROGRAM_ENABLED=${ERP_MINIPROGRAM_ENABLED:-0}
ERP_WECHAT_APP_ID=${ERP_WECHAT_APP_ID:-}
ERP_WECHAT_APP_SECRET=${ERP_WECHAT_APP_SECRET:-}
EOF
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

# ---------- 生产环境预检 ----------
log "执行生产环境预检（fail closed）"
if [ "$DRY_RUN" = "0" ]; then
  set -a; . "$ENV_FILE"; set +a
  if ! "$NODE_BIN" "$APP_ROOT/current/scripts/check-aliyun-production.cjs"; then
    die "预检未通过，未启动服务。修正 $ENV_FILE 后重跑。"
  fi
fi

# ---------- systemd ----------
log "安装 systemd 单元"
UNIT_SRC="$APP_ROOT/current/deploy/aliyun/erp.service"
[ "$DRY_RUN" = "1" ] || [ -f "$UNIT_SRC" ] || die "缺少 $UNIT_SRC"
if [ "$DRY_RUN" = "0" ]; then
  sed "s#/usr/bin/node#${NODE_BIN}#g" "$UNIT_SRC" > /etc/systemd/system/erp.service
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null
fi

# ---------- Nginx ----------
# 顺序很关键：证书不存在时不能先装带 ssl_certificate 的配置，否则 nginx -t 直接失败。
# 所以先起一个纯 HTTP 站点，交给 certbot --nginx 自己签发并改写成 HTTPS。
SITE_AVAIL="/etc/nginx/sites-available/erp-${DOMAIN}.conf"
SITE_ENABLED="/etc/nginx/sites-enabled/erp-${DOMAIN}.conf"
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
        proxy_pass http://127.0.0.1:8787;
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
  systemctl reload nginx
fi

# ---------- TLS ----------
if [ "$SKIP_TLS" = "0" ]; then
  if [ -f "$CERT_DIR/fullchain.pem" ] && [ "$DRY_RUN" = "0" ]; then
    log "证书已存在，跳过签发"
  else
    log "申请 Let's Encrypt 证书（需要 $DOMAIN 已解析到本机且 80 端口放通）"
    if [ "$DRY_RUN" = "0" ]; then
      certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$ACME_EMAIL" --redirect \
        || die "证书签发失败：确认 $DOMAIN 的 A 记录已指向本机、安全组放通 80/443 后重跑"
      nginx -t && systemctl reload nginx
    fi
  fi
else
  warn "已跳过 TLS。上线前必须补证书，否则浏览器会拦。"
fi

# ---------- 启动 ----------
log "启动服务"
run systemctl restart "$SERVICE"

if [ "$DRY_RUN" = "0" ]; then
  for i in $(seq 1 60); do
    if curl -fsS --max-time 2 http://127.0.0.1:8787/api/health >/dev/null 2>&1; then
      log "健康检查通过：http://127.0.0.1:8787/api/health"
      break
    fi
    [ "$i" -eq 60 ] && { journalctl -u "$SERVICE" -n 40 --no-pager; die "服务未在 60 秒内就绪"; }
    sleep 1
  done
fi

# ---------- 备份 ----------
log "安装每日备份（sqlite3 .backup，保留 30 天）"
if [ "$DRY_RUN" = "0" ]; then
  cat > /usr/local/sbin/erp-backup <<'BACKUP'
#!/usr/bin/env bash
set -Eeuo pipefail
DB=/var/lib/erp/erp.db
OUT=/var/lib/erp/backup
STAMP=$(date +%Y%m%d-%H%M%S)
[ -f "$DB" ] || exit 0
sqlite3 "$DB" ".backup '$OUT/erp-$STAMP.db'"
rsync -a --delete /var/lib/erp/uploads/ "$OUT/uploads-current/"
gzip -f "$OUT/erp-$STAMP.db"
find "$OUT" -name 'erp-*.db.gz' -mtime +30 -delete
BACKUP
  chmod 0750 /usr/local/sbin/erp-backup
  cat > /etc/systemd/system/erp-backup.service <<'UNIT'
[Unit]
Description=ERP SQLite backup
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/erp-backup
UNIT
  cat > /etc/systemd/system/erp-backup.timer <<'UNIT'
[Unit]
Description=Daily ERP backup
[Timer]
OnCalendar=*-*-* 03:20:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now erp-backup.timer >/dev/null
fi

cat <<EOF

────────────────────────────────────────────────────────
 部署完成
────────────────────────────────────────────────────────
 域名        https://${DOMAIN}
 服务        systemctl status ${SERVICE}
 日志        journalctl -u ${SERVICE} -f
 配置        ${ENV_FILE}（0600，含 ERP_SECRET 与短信密钥）
 数据        ${DATA_ROOT}/erp.db   附件 ${DATA_ROOT}/uploads
 备份        /var/lib/erp/backup（每日 03:20，保留 30 天）
 回滚        ln -sfn ${APP_ROOT}/releases/<旧版本> ${APP_ROOT}/current && systemctl restart ${SERVICE}

 首次登录    手机号 ${ADMIN_PHONE} / 密码 123456
             登录后必须先用短信验证码改密，短信通道不通则无法进入业务。
────────────────────────────────────────────────────────
EOF

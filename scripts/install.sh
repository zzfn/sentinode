#!/bin/sh
set -e

REPO="zzfn/sentinode"
BIN_NAME="sentinode-agent"
INSTALL_DIR="/usr/local/bin"

# ── 参数解析 ──────────────────────────────────────────────────────────────────
usage() {
  echo "用法: install.sh --server <服务器地址> --token <TOKEN> [--interval <秒>]"
  echo ""
  echo "示例:"
  echo "  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh \\"
  echo "    | sh -s -- --server https://api.example.com --token abc123"
  exit 1
}

SERVER=""
TOKEN=""
INTERVAL=30

while [ $# -gt 0 ]; do
  case "$1" in
    --server)   SERVER="$2";   shift 2 ;;
    --token)    TOKEN="$2";    shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    *) echo "未知参数: $1"; usage ;;
  esac
done

[ -z "$SERVER" ] && { echo "错误：缺少 --server"; usage; }
[ -z "$TOKEN" ]  && { echo "错误：缺少 --token";  usage; }

# ── 架构检测 ──────────────────────────────────────────────────────────────────
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  FILE="${BIN_NAME}-linux-amd64"  ;;
  aarch64) FILE="${BIN_NAME}-linux-arm64"  ;;
  *) echo "不支持的架构: $ARCH" >&2; exit 1 ;;
esac

# ── 检测 init 系统 ────────────────────────────────────────────────────────────
detect_init() {
  if [ -d /run/systemd/private ] || command -v systemctl >/dev/null 2>&1 && systemctl status >/dev/null 2>&1; then
    echo "systemd"
  elif [ -f /sbin/openrc-run ] || [ -f /etc/alpine-release ]; then
    echo "openrc"
  else
    echo "none"
  fi
}

INIT_SYS=$(detect_init)
echo "→ Init 系统: $INIT_SYS"

# ── 获取最新版本号 ────────────────────────────────────────────────────────────
echo "→ 获取最新版本..."
VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep '"tag_name"' | head -1 | cut -d'"' -f4)

[ -z "$VERSION" ] && { echo "无法获取版本号，请检查网络" >&2; exit 1; }
echo "→ 版本: $VERSION  架构: $ARCH"

# ── 停止旧服务 ────────────────────────────────────────────────────────────────
case "$INIT_SYS" in
  systemd) systemctl stop sentinode-agent 2>/dev/null || true ;;
  openrc)  rc-service sentinode-agent stop 2>/dev/null || true ;;
esac

# ── 下载二进制 ────────────────────────────────────────────────────────────────
echo "→ 下载 ${FILE}..."
curl -fsSL \
  "https://github.com/${REPO}/releases/download/${VERSION}/${FILE}" \
  -o "${INSTALL_DIR}/${BIN_NAME}"
chmod +x "${INSTALL_DIR}/${BIN_NAME}"
echo "→ 已安装到 ${INSTALL_DIR}/${BIN_NAME}"

# ── 注册服务 ──────────────────────────────────────────────────────────────────
case "$INIT_SYS" in
  systemd)
    SERVICE_FILE="/etc/systemd/system/sentinode-agent.service"
    cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Sentinode Agent
After=network.target

[Service]
Environment=SENTINODE_SERVER=${SERVER}
Environment=SENTINODE_TOKEN=${TOKEN}
Environment=SENTINODE_INTERVAL=${INTERVAL}
ExecStart=${INSTALL_DIR}/${BIN_NAME}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now sentinode-agent
    echo ""
    echo "✅ sentinode-agent ${VERSION} 已安装并启动"
    echo "   查看日志: journalctl -u sentinode-agent -f"
    ;;

  openrc)
    INIT_FILE="/etc/init.d/sentinode-agent"
    cat > "$INIT_FILE" << EOF
#!/sbin/openrc-run

description="Sentinode Agent"
command="${INSTALL_DIR}/${BIN_NAME}"
command_background=true
pidfile="/run/sentinode-agent.pid"
output_log="/var/log/sentinode-agent.log"
error_log="/var/log/sentinode-agent.log"

export SENTINODE_SERVER="${SERVER}"
export SENTINODE_TOKEN="${TOKEN}"
export SENTINODE_INTERVAL="${INTERVAL}"

depend() {
  need net
}
EOF
    chmod +x "$INIT_FILE"
    rc-update add sentinode-agent default
    rc-service sentinode-agent start
    echo ""
    echo "✅ sentinode-agent ${VERSION} 已安装并启动 (OpenRC)"
    echo "   查看日志: tail -f /var/log/sentinode-agent.log"
    ;;

  none)
    # 无 init 系统（容器等），写环境变量文件后台运行
    ENV_FILE="/etc/sentinode-agent.env"
    cat > "$ENV_FILE" << EOF
SENTINODE_SERVER=${SERVER}
SENTINODE_TOKEN=${TOKEN}
SENTINODE_INTERVAL=${INTERVAL}
EOF
    echo ""
    echo "⚠️  未检测到 init 系统，已安装二进制但未配置自启动"
    echo "   手动启动: env \$(cat ${ENV_FILE} | xargs) ${INSTALL_DIR}/${BIN_NAME} &"
    ;;
esac

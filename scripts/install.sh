#!/bin/sh
set -e

REPO="zzfn/sentinode"
BIN_NAME="sentinode-agent"
INSTALL_DIR="/usr/local/bin"
SERVICE_FILE="/etc/systemd/system/sentinode-agent.service"

# ── 参数解析 ──────────────────────────────────────────────────────────────────
usage() {
  echo "用法: install.sh --server <gRPC地址> --token <TOKEN> [--interval <秒>]"
  echo ""
  echo "示例:"
  echo "  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh \\"
  echo "    | sh -s -- --server https://grpc.example.com --token abc123"
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

# ── 获取最新版本号 ────────────────────────────────────────────────────────────
echo "→ 获取最新版本..."
VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep '"tag_name"' | head -1 | cut -d'"' -f4)

[ -z "$VERSION" ] && { echo "无法获取版本号，请检查网络" >&2; exit 1; }
echo "→ 版本: $VERSION  架构: $ARCH"

# ── 下载二进制 ────────────────────────────────────────────────────────────────
systemctl stop sentinode-agent 2>/dev/null || true
echo "→ 下载 ${FILE}..."
curl -fsSL \
  "https://github.com/${REPO}/releases/download/${VERSION}/${FILE}" \
  -o "${INSTALL_DIR}/${BIN_NAME}"
chmod +x "${INSTALL_DIR}/${BIN_NAME}"
echo "→ 已安装到 ${INSTALL_DIR}/${BIN_NAME}"

# ── 写入 systemd 服务 ─────────────────────────────────────────────────────────
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

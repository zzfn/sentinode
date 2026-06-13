#!/usr/bin/env bash
# 彻底卸载 NodeGet (server / agent) 及其全部残留
# 在目标 Linux VPS 上以 root 运行：sudo bash uninstall-nodeget.sh
set -u

# ---------- 颜色 ----------
red()  { echo -e "\033[0;31m$*\033[0m"; }
grn()  { echo -e "\033[0;32m$*\033[0m"; }
ylw()  { echo -e "\033[0;33m$*\033[0m"; }
blu()  { echo -e "\033[0;36m$*\033[0m"; }

# ---------- 参数 ----------
ROLES=""          # server / agent / both
ASSUME_YES=1      # 默认一键卸载，不询问；加 --ask 才需确认
KEEP_DATA=0
RM_PKGS=0

usage() {
cat <<EOF
用法: sudo bash uninstall-nodeget.sh [选项]

选项:
  --server        只卸载主控 (server)
  --agent         只卸载被控 (agent)
  --all           server + agent 都卸 (默认自动检测)
  --keep-data     保留 /var/lib 数据目录(sqlite库、证书)，只删程序和服务
  --purge-pkgs    连带卸载脚本自动安装的 curl/unzip/openssl(谨慎，默认保留)
  --ask           执行前需手动确认(默认一键直删，不询问)
  -y, --yes       (默认行为)跳过确认
  -h, --help      显示帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --server)     ROLES="server" ;;
    --agent)      ROLES="agent" ;;
    --all)        ROLES="both" ;;
    --keep-data)  KEEP_DATA=1 ;;
    --purge-pkgs) RM_PKGS=1 ;;
    --ask)        ASSUME_YES=0 ;;
    -y|--yes)     ASSUME_YES=1 ;;
    -h|--help)    usage; exit 0 ;;
    *) red "未知参数: $1"; usage; exit 1 ;;
  esac
  shift
done

# ---------- root 检查 ----------
if [ "$(id -u)" != "0" ]; then
  red "请用 root 运行：sudo bash uninstall-nodeget.sh"
  exit 1
fi

# ---------- 自动检测已安装角色 ----------
detect_role_installed() {
  local r="$1"
  [ -f "/usr/local/bin/nodeget-$r" ] && return 0
  [ -f "/etc/systemd/system/nodeget-$r.service" ] && return 0
  [ -f "/etc/nodeget-$r.toml" ] && return 0
  [ -d "/var/lib/nodeget-$r" ] && return 0
  return 1
}

if [ -z "$ROLES" ] || [ "$ROLES" = "both" ]; then
  ROLES=""
  detect_role_installed server && ROLES="$ROLES server"
  detect_role_installed agent  && ROLES="$ROLES agent"
  ROLES="$(echo "$ROLES" | xargs)"   # trim
fi

if [ -z "$ROLES" ]; then
  ylw "未检测到任何 NodeGet 安装痕迹，无需卸载。"
  exit 0
fi

# ---------- init 系统 ----------
if command -v systemctl >/dev/null 2>&1; then INIT="systemd"
elif command -v rc-update >/dev/null 2>&1; then INIT="openrc"
elif [ -d /etc/init.d ]; then INIT="sysvinit"
else INIT="unknown"; fi

# ---------- 预览将删除的内容 ----------
collect_targets() {
  local r="$1"
  echo "/usr/local/bin/nodeget-$r"
  echo "/etc/systemd/system/nodeget-$r.service"
  echo "/etc/init.d/nodeget-$r"
  echo "/etc/nodeget-$r.toml"
  echo "/etc/nodeget-$r.conf"
  echo "/etc/nodeget-$r.d"
  echo "/var/log/nodeget-$r"
  echo "/var/run/nodeget-$r"
  if [ "$KEEP_DATA" -eq 0 ]; then
    echo "/var/lib/nodeget-$r"
    echo "/var/lib/nodeget-$r.backup"
  fi
}

blu "==> 检测到角色: $ROLES   (init: $INIT)"
echo "将停止服务并删除以下存在的项："
for r in $ROLES; do
  for p in $(collect_targets "$r"); do
    [ -e "$p" ] && echo "    $p"
  done
done
# cloudflared
if [ -f /usr/local/cloudflared ] || pgrep -f /usr/local/cloudflared >/dev/null 2>&1; then
  echo "    /usr/local/cloudflared (+后台进程) /tmp/cloudflared_*.log"
fi
[ "$KEEP_DATA" -eq 1 ] && ylw "    (--keep-data: 保留 /var/lib 数据目录)"

echo
if [ "$ASSUME_YES" -ne 1 ]; then
  read -rp "确认删除以上内容? [y/N] " ans
  case "$ans" in y|Y|yes|YES) ;; *) ylw "已取消。"; exit 0 ;; esac
fi

# ---------- 停服务 + 删服务定义 ----------
stop_service() {
  local svc="$1"
  case "$INIT" in
    systemd)
      systemctl disable --now "$svc" >/dev/null 2>&1
      rm -f "/etc/systemd/system/$svc.service"
      ;;
    openrc)
      rc-service "$svc" stop >/dev/null 2>&1
      rc-update del "$svc" >/dev/null 2>&1
      rm -f "/etc/init.d/$svc"
      ;;
    sysvinit)
      service "$svc" stop >/dev/null 2>&1
      command -v update-rc.d >/dev/null 2>&1 && update-rc.d -f "$svc" remove >/dev/null 2>&1
      command -v chkconfig  >/dev/null 2>&1 && chkconfig --del "$svc" >/dev/null 2>&1
      rm -f "/etc/init.d/$svc"
      ;;
  esac
}

for r in $ROLES; do
  blu "==> 卸载 nodeget-$r ..."
  stop_service "nodeget-$r"
  rm -f  "/usr/local/bin/nodeget-$r"
  rm -f  "/etc/nodeget-$r.toml" "/etc/nodeget-$r.conf"
  rm -rf "/etc/nodeget-$r.d" "/var/log/nodeget-$r" "/var/run/nodeget-$r"
  if [ "$KEEP_DATA" -eq 0 ]; then
    rm -rf "/var/lib/nodeget-$r" "/var/lib/nodeget-$r.backup"
  fi
  grn "    nodeget-$r 已清理"
done

[ "$INIT" = "systemd" ] && systemctl daemon-reload

# ---------- cloudflared ----------
if pgrep -f /usr/local/cloudflared >/dev/null 2>&1; then
  pkill -f /usr/local/cloudflared && grn "==> 已停止 cloudflared 进程"
fi
rm -f /usr/local/cloudflared /tmp/cloudflared_*.log 2>/dev/null

# ---------- 可选: 卸载依赖包 ----------
if [ "$RM_PKGS" -eq 1 ]; then
  blu "==> 卸载脚本曾自动安装的依赖 (curl/unzip/openssl)"
  ylw "    注意: 这些是常用工具，若系统其它地方在用请勿删。"
  if   command -v apt-get >/dev/null 2>&1; then apt-get remove -y unzip openssl 2>/dev/null
  elif command -v dnf     >/dev/null 2>&1; then dnf remove -y unzip openssl 2>/dev/null
  elif command -v yum     >/dev/null 2>&1; then yum remove -y unzip openssl 2>/dev/null
  elif command -v apk     >/dev/null 2>&1; then apk del unzip openssl 2>/dev/null
  elif command -v pacman  >/dev/null 2>&1; then pacman -Rns --noconfirm unzip openssl 2>/dev/null
  fi
fi

# ---------- 核验 ----------
echo
blu "==> 核验残留:"
left=0
for r in server agent; do
  for p in "/usr/local/bin/nodeget-$r" "/etc/systemd/system/nodeget-$r.service" \
           "/etc/init.d/nodeget-$r" "/etc/nodeget-$r.toml" "/etc/nodeget-$r.conf" \
           "/etc/nodeget-$r.d" "/var/log/nodeget-$r" "/var/run/nodeget-$r" \
           "/var/lib/nodeget-$r" "/var/lib/nodeget-$r.backup"; do
    if [ -e "$p" ]; then red "    残留: $p"; left=1; fi
  done
done
pgrep -af 'nodeget|cloudflared' >/dev/null 2>&1 && { red "    仍有进程:"; pgrep -af 'nodeget|cloudflared'; left=1; }

if [ "$left" -eq 0 ]; then
  grn "✅ NodeGet 已彻底卸载，无残留。"
else
  ylw "⚠️ 仍有上述残留(可能是 --keep-data 保留的数据)，按需手动处理。"
fi

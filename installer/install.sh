#!/bin/bash
set -euo pipefail

EXTENSION_ID="dnajjjjocfgibphegclgajmdbjbdfbkf"
HOST_NAME="com.codex.lan_drop_receiver"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_SUPPORT_DIR="${HOME}/Library/Application Support/LAN Drop Receiver"
DOWNLOAD_DIR="${HOME}/Documents/局域网互传"
INSTALLED_HOST_DIR="${APP_SUPPORT_DIR}/native-host"
CHROME_HOST_DIR="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
HOST_MANIFEST_PATH="${CHROME_HOST_DIR}/${HOST_NAME}.json"
AUTO_CONFIRM="false"

if [[ "${1:-}" == "--yes" ]]; then
  AUTO_CONFIRM="true"
elif [[ -n "${1:-}" ]]; then
  echo "未知参数：${1}" >&2
  echo "用法：./installer/install.sh [--yes]" >&2
  exit 2
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "当前安装脚本只支持 macOS。" >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "未找到 Node.js。请先安装 Node.js 18 或更高版本。" >&2
  exit 1
fi

NODE_MAJOR="$("${NODE_BIN}" -p 'Number(process.versions.node.split(".")[0])')"
if [[ "${NODE_MAJOR}" -lt 18 ]]; then
  echo "Node.js 版本过低：$("${NODE_BIN}" -v)。需要 18 或更高版本。" >&2
  exit 1
fi

echo "即将安装局域网投送站的本地辅助程序："
echo
echo "  扩展 ID：${EXTENSION_ID}"
echo "  本地程序：${APP_SUPPORT_DIR}"
echo "  Chrome 注册：${HOST_MANIFEST_PATH}"
echo "  接收文件：${DOWNLOAD_DIR}（首次接收时创建）"
echo "  Node.js：${NODE_BIN}"
echo
echo "不会创建 LaunchAgent、登录项、定时任务或后台常驻服务。"

if [[ "${AUTO_CONFIRM}" != "true" ]]; then
  read -r -p "继续安装？[y/N] " ANSWER
  if [[ ! "${ANSWER}" =~ ^[Yy]$ ]]; then
    echo "已取消。"
    exit 0
  fi
fi

EXPECTED_APP_SUPPORT="${HOME}/Library/Application Support/LAN Drop Receiver"
if [[ "${APP_SUPPORT_DIR}" != "${EXPECTED_APP_SUPPORT}" ]]; then
  echo "安装目录校验失败，已停止。" >&2
  exit 1
fi

STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lan-drop-receiver-install.XXXXXX")"
trap 'rm -rf "${STAGING_DIR}"' EXIT

mkdir -p "${STAGING_DIR}/native-host/public"
cp "${PROJECT_ROOT}/native-host/host.js" "${STAGING_DIR}/native-host/host.js"
cp "${PROJECT_ROOT}/native-host/server.js" "${STAGING_DIR}/native-host/server.js"
cp "${PROJECT_ROOT}/native-host/public/index.html" "${STAGING_DIR}/native-host/public/index.html"
cp "${PROJECT_ROOT}/native-host/public/styles.css" "${STAGING_DIR}/native-host/public/styles.css"
cp "${PROJECT_ROOT}/native-host/public/app.js" "${STAGING_DIR}/native-host/public/app.js"

cat > "${STAGING_DIR}/run-host" <<EOF
#!/bin/bash
exec "${NODE_BIN}" "${INSTALLED_HOST_DIR}/host.js"
EOF
chmod 700 "${STAGING_DIR}/run-host"

cat > "${STAGING_DIR}/install-receipt.json" <<EOF
{
  "product": "LAN Drop Receiver",
  "version": "0.2.2",
  "extensionId": "${EXTENSION_ID}",
  "sourceProject": "${PROJECT_ROOT}",
  "installedHost": "${INSTALLED_HOST_DIR}",
  "nativeHostManifest": "${HOST_MANIFEST_PATH}",
  "downloadDirectory": "${DOWNLOAD_DIR}"
}
EOF

mkdir -p "${HOME}/Library/Application Support"
if [[ -d "${APP_SUPPORT_DIR}" ]]; then
  rm -rf "${APP_SUPPORT_DIR}"
fi
mv "${STAGING_DIR}" "${APP_SUPPORT_DIR}"
trap - EXIT

mkdir -p "${CHROME_HOST_DIR}"
cat > "${HOST_MANIFEST_PATH}" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "LAN Drop Receiver on-demand native host",
  "path": "${APP_SUPPORT_DIR}/run-host",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXTENSION_ID}/"
  ]
}
EOF
chmod 600 "${HOST_MANIFEST_PATH}"

echo
echo "本地辅助程序安装完成。"
echo "下一步：在 chrome://extensions 中加载下面的目录："
echo "  ${PROJECT_ROOT}/extension"
echo
echo "完整落盘清单：${PROJECT_ROOT}/CODE_INVENTORY.md"
echo "完整卸载：${PROJECT_ROOT}/installer/uninstall.sh"

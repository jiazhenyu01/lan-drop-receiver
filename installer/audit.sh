#!/bin/bash
set -euo pipefail

HOST_NAME="com.codex.lan_drop_receiver"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_SUPPORT_DIR="${HOME}/Library/Application Support/LAN Drop Receiver"
HOST_MANIFEST_PATH="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts/${HOST_NAME}.json"
DOWNLOAD_DIR="${HOME}/Documents/局域网互传"
LEGACY_DOWNLOAD_DIR="${HOME}/Downloads/LAN Drop Receiver"
FOUND_COUNT=0

report_path() {
  local LABEL="$1"
  local TARGET="$2"
  if [[ -e "${TARGET}" ]]; then
    echo "[存在] ${LABEL}: ${TARGET}"
    FOUND_COUNT=$((FOUND_COUNT + 1))
  else
    echo "[无]   ${LABEL}: ${TARGET}"
  fi
}

echo "局域网投送站落盘审计"
echo
report_path "项目源码" "${PROJECT_ROOT}"
report_path "Native Host 安装副本" "${APP_SUPPORT_DIR}"
report_path "Chrome Native Host 注册" "${HOST_MANIFEST_PATH}"
report_path "已接收用户文件目录" "${DOWNLOAD_DIR}"
report_path "旧版已接收用户文件目录" "${LEGACY_DOWNLOAD_DIR}"

PARTIAL_COUNT=0
for PARTIAL_DIRECTORY in "${DOWNLOAD_DIR}" "${LEGACY_DOWNLOAD_DIR}"; do
  while IFS= read -r -d '' PARTIAL_FILE; do
    FILE_NAME="$(basename "${PARTIAL_FILE}")"
    if [[ ! "${FILE_NAME}" =~ ^\.lan-drop-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.part$ ]]; then
      continue
    fi
    echo "[存在] 未完成上传分片: ${PARTIAL_FILE}"
    PARTIAL_COUNT=$((PARTIAL_COUNT + 1))
    FOUND_COUNT=$((FOUND_COUNT + 1))
  done < <(find "${PARTIAL_DIRECTORY}" -maxdepth 1 -type f -name '.lan-drop-*.part' -print0 2>/dev/null)
done
if [[ "${PARTIAL_COUNT}" -eq 0 ]]; then
  echo "[无]   未完成上传分片"
fi

PROCESS_COUNT=0
if command -v pgrep >/dev/null 2>&1; then
  while IFS= read -r PROCESS_ID; do
    [[ -z "${PROCESS_ID}" ]] && continue
    PROCESS_COMMAND="$(ps -p "${PROCESS_ID}" -o command= 2>/dev/null || true)"
    if [[ "${PROCESS_COMMAND}" == *"${APP_SUPPORT_DIR}/native-host/host.js"* ]]; then
      echo "[运行] Native Host 进程 ${PROCESS_ID}: ${PROCESS_COMMAND}"
      PROCESS_COUNT=$((PROCESS_COUNT + 1))
      FOUND_COUNT=$((FOUND_COUNT + 1))
    fi
  done < <(pgrep -f "${APP_SUPPORT_DIR}/native-host/host.js" || true)
fi
if [[ "${PROCESS_COUNT}" -eq 0 ]]; then
  echo "[无]   Native Host 运行进程"
fi

echo
echo "固定扩展 ID: dnajjjjocfgibphegclgajmdbjbdfbkf"
echo "已接收的完整文件属于用户数据；默认卸载会保留，--purge-downloads 才会删除。"
echo "Chrome 内部安装记录请在 chrome://extensions 中检查；本脚本不会读取或修改 Chrome Profile 数据库。"
echo
echo "共发现 ${FOUND_COUNT} 项本项目相关内容（包含当前项目源码本身）。"

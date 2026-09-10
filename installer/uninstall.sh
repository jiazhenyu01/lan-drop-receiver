#!/bin/bash
set -euo pipefail

HOST_NAME="com.codex.lan_drop_receiver"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_SUPPORT_DIR="${HOME}/Library/Application Support/LAN Drop Receiver"
HOST_MANIFEST_PATH="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts/${HOST_NAME}.json"
DOWNLOAD_DIR="${HOME}/Documents/局域网互传"
LEGACY_DOWNLOAD_DIR="${HOME}/Downloads/LAN Drop Receiver"
AUTO_CONFIRM="false"
PURGE_SOURCE="false"
PURGE_DOWNLOADS="false"

for ARGUMENT in "$@"; do
  case "${ARGUMENT}" in
    --yes)
      AUTO_CONFIRM="true"
      ;;
    --purge-source)
      PURGE_SOURCE="true"
      ;;
    --purge-downloads)
      PURGE_DOWNLOADS="true"
      ;;
    *)
      echo "未知参数：${ARGUMENT}" >&2
      echo "用法：./installer/uninstall.sh [--yes] [--purge-source] [--purge-downloads]" >&2
      exit 2
      ;;
  esac
done

EXPECTED_APP_SUPPORT="${HOME}/Library/Application Support/LAN Drop Receiver"
EXPECTED_MANIFEST="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts/${HOST_NAME}.json"
EXPECTED_DOWNLOAD_DIR="${HOME}/Documents/局域网互传"
EXPECTED_LEGACY_DOWNLOAD_DIR="${HOME}/Downloads/LAN Drop Receiver"
if [[ "${APP_SUPPORT_DIR}" != "${EXPECTED_APP_SUPPORT}" || "${HOST_MANIFEST_PATH}" != "${EXPECTED_MANIFEST}" || "${DOWNLOAD_DIR}" != "${EXPECTED_DOWNLOAD_DIR}" || "${LEGACY_DOWNLOAD_DIR}" != "${EXPECTED_LEGACY_DOWNLOAD_DIR}" ]]; then
  echo "卸载路径校验失败，已停止。" >&2
  exit 1
fi

echo "请先在 chrome://extensions 中移除“局域网投送站”。"
echo "Chrome 会负责清除该扩展自己的 session 状态。"
echo
echo "本脚本将删除："
echo "  ${HOST_MANIFEST_PATH}"
echo "  ${APP_SUPPORT_DIR}"
echo "  ${DOWNLOAD_DIR}/.lan-drop-*.part（仅未完成上传分片）"
echo "  ${LEGACY_DOWNLOAD_DIR}/.lan-drop-*.part（仅清理旧版未完成上传分片）"
if [[ "${PURGE_DOWNLOADS}" == "true" ]]; then
  echo "  ${DOWNLOAD_DIR}（包含所有已接收的用户文件）"
  echo "  ${LEGACY_DOWNLOAD_DIR}（包含旧版本已接收的用户文件）"
else
  echo
  echo "已接收的文件将保留在：${DOWNLOAD_DIR}"
  echo "只有显式增加 --purge-downloads 才会删除这些用户文件。"
fi
if [[ "${PURGE_SOURCE}" == "true" ]]; then
  echo "  ${PROJECT_ROOT}（项目源码）"
fi
echo
echo "不会修改 Chrome 用户配置目录中的其他内容。"

if [[ "${AUTO_CONFIRM}" != "true" ]]; then
  read -r -p "确认继续？[y/N] " ANSWER
  if [[ ! "${ANSWER}" =~ ^[Yy]$ ]]; then
    echo "已取消。"
    exit 0
  fi
fi

if command -v pgrep >/dev/null 2>&1; then
  while IFS= read -r PROCESS_ID; do
    [[ -z "${PROCESS_ID}" ]] && continue
    PROCESS_COMMAND="$(ps -p "${PROCESS_ID}" -o command= 2>/dev/null || true)"
    if [[ "${PROCESS_COMMAND}" == *"${APP_SUPPORT_DIR}/native-host/host.js"* ]]; then
      kill -TERM "${PROCESS_ID}" 2>/dev/null || true
    fi
  done < <(pgrep -f "${APP_SUPPORT_DIR}/native-host/host.js" || true)
fi

rm -f "${HOST_MANIFEST_PATH}"
rm -rf "${APP_SUPPORT_DIR}"

for PARTIAL_DIRECTORY in "${DOWNLOAD_DIR}" "${LEGACY_DOWNLOAD_DIR}"; do
  if [[ ! -d "${PARTIAL_DIRECTORY}" ]]; then
    continue
  fi
  while IFS= read -r -d '' PARTIAL_FILE; do
    FILE_NAME="$(basename "${PARTIAL_FILE}")"
    if [[ "${FILE_NAME}" =~ ^\.lan-drop-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.part$ ]]; then
      rm -f "${PARTIAL_FILE}"
    fi
  done < <(find "${PARTIAL_DIRECTORY}" -maxdepth 1 -type f -name '.lan-drop-*.part' -print0 2>/dev/null)
done

echo "Native Host、注册文件和未完成上传分片已清除。"

if [[ "${PURGE_DOWNLOADS}" == "true" ]]; then
  if [[ "${DOWNLOAD_DIR}" == "${HOME}/Documents/局域网互传" && "${LEGACY_DOWNLOAD_DIR}" == "${HOME}/Downloads/LAN Drop Receiver" ]]; then
    rm -rf "${DOWNLOAD_DIR}"
    rm -rf "${LEGACY_DOWNLOAD_DIR}"
    echo "当前及旧版已接收的用户文件目录已清除。"
  else
    echo "下载目录校验失败，未删除：${DOWNLOAD_DIR}" >&2
    exit 1
  fi
fi

if [[ "${PURGE_SOURCE}" == "true" ]]; then
  case "${PROJECT_ROOT}" in
    */lan-drop-receiver)
      rm -rf "${PROJECT_ROOT}"
      echo "项目源码已清除。"
      ;;
    *)
      echo "源码目录名称校验失败，未删除：${PROJECT_ROOT}" >&2
      exit 1
      ;;
  esac
fi

echo "卸载完成。"

"use strict";

const sessionDot = document.getElementById("sessionDot");
const sessionTitle = document.getElementById("sessionTitle");
const sessionMessage = document.getElementById("sessionMessage");
const sessionCountdown = document.getElementById("sessionCountdown");
const accessPanel = document.getElementById("accessPanel");
const receiverQrCanvas = document.getElementById("receiverQrCanvas");
const receiverMobileUrl = document.getElementById("receiverMobileUrl");
const receiverNetworkNote = document.getElementById("receiverNetworkNote");
const receiverSaveNote = document.getElementById("receiverSaveNote");
const receiverCopyUrlButton = document.getElementById("receiverCopyUrlButton");
const receivedCount = document.getElementById("receivedCount");
const clearButton = document.getElementById("clearButton");
const itemsGrid = document.getElementById("itemsGrid");
const emptyState = document.getElementById("emptyState");
const textItemTemplate = document.getElementById("textItemTemplate");
const fileItemTemplate = document.getElementById("fileItemTemplate");
const toast = document.getElementById("toast");

let currentState = null;
let timerId = null;
let toastId = null;
let lastQrUrl = "";

function sendMessage(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response?.ok) {
      throw new Error(response?.error || "操作失败");
    }
    return response.state;
  });
}

function showToast(message, isError) {
  window.clearTimeout(toastId);
  toast.textContent = message;
  toast.classList.toggle("is-error", Boolean(isError));
  toast.classList.add("is-visible");
  toastId = window.setTimeout(() => toast.classList.remove("is-visible"), 2200);
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(timestamp));
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatCountdown(expiresAt) {
  const remaining = Math.max(0, Number(expiresAt) - Date.now());
  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function drawQrCode(url) {
  if (!url || url === lastQrUrl) {
    return;
  }

  const qrFactory = globalThis.qrcode;
  qrFactory.stringToBytes = qrFactory.stringToBytesFuncs["UTF-8"];
  const qr = qrFactory(0, "L");
  qr.addData(url, "Byte");
  qr.make();

  const moduleCount = qr.getModuleCount();
  const quietZone = 3;
  const cellSize = Math.max(2, Math.floor(128 / (moduleCount + quietZone * 2)));
  const logicalSize = (moduleCount + quietZone * 2) * cellSize;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);

  receiverQrCanvas.width = logicalSize * ratio;
  receiverQrCanvas.height = logicalSize * ratio;
  receiverQrCanvas.style.width = `${logicalSize}px`;
  receiverQrCanvas.style.height = `${logicalSize}px`;

  const context = receiverQrCanvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.imageSmoothingEnabled = false;
  context.fillStyle = "#f3f0e6";
  context.fillRect(0, 0, logicalSize, logicalSize);
  context.fillStyle = "#111812";

  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (qr.isDark(row, column)) {
        context.fillRect(
          (column + quietZone) * cellSize,
          (row + quietZone) * cellSize,
          cellSize,
          cellSize
        );
      }
    }
  }

  lastQrUrl = url;
}

function updateCountdown() {
  sessionCountdown.textContent =
    currentState?.status === "running" ? formatCountdown(currentState.expiresAt) : "00:00";
}

function createSourceLabel(item) {
  const address = item.remoteAddress || "局域网设备";
  return `${address} · ${formatBytes(item.size)}`;
}

function renderTextItem(item) {
  const card = textItemTemplate.content.firstElementChild.cloneNode(true);
  card.dataset.itemId = item.id;
  card.querySelector("time").textContent = formatTime(item.receivedAt);
  card.querySelector("pre").textContent = item.text;
  card.querySelector(".source-label").textContent = createSourceLabel(item);
  card.querySelector(".delete-button").addEventListener("click", () => deleteItem(item.id));
  card.querySelector(".copy-button").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(item.text);
      showToast("文本已复制");
    } catch (_error) {
      showToast("复制失败，请手动选择文本", true);
    }
  });
  return card;
}

function renderFileItem(item) {
  const card = fileItemTemplate.content.firstElementChild.cloneNode(true);
  card.dataset.itemId = item.id;
  card.querySelector(".kind-badge").textContent = item.kind === "image" ? "IMAGE" : "FILE";
  card.querySelector("time").textContent = formatTime(item.receivedAt);
  card.querySelector("h2").textContent = item.name;
  card.querySelector(".file-meta").textContent =
    `${item.mime || "未知类型"} · ${formatBytes(item.size)}`;
  const savedPath = item.savedPath || item.savedDirectory || "";
  const savedPathElement = card.querySelector(".saved-path");
  savedPathElement.textContent = savedPath
    ? `已保存：${savedPath}`
    : "已保存到 ~/Documents/局域网互传";
  savedPathElement.title = savedPath;
  card.querySelector(".source-label").textContent = item.remoteAddress || "局域网设备";
  card.querySelector(".delete-button").addEventListener("click", () => deleteItem(item.id));

  card
    .querySelector(".reveal-button")
    .addEventListener("click", () => revealItem(item.id));

  if (item.kind === "image") {
    const preview = card.querySelector(".image-preview");
    const image = preview.querySelector("img");
    preview.hidden = false;
    image.src = item.viewUrl;
    image.alt = item.name;
    card.querySelector(".file-mark").hidden = true;
  }

  return card;
}

function renderItems(items) {
  itemsGrid.replaceChildren();
  items.forEach((item) => {
    itemsGrid.append(item.kind === "text" ? renderTextItem(item) : renderFileItem(item));
  });
  emptyState.hidden = items.length > 0;
}

function render(state) {
  currentState = state;
  document.querySelector("send-panel").setSession(state);
  const isRunning = state.status === "running";
  const isError = state.status === "error";
  const items = Array.isArray(state.items) ? state.items : [];
  const primaryAddress = state.mobileUrls?.[0];

  document.body.dataset.status = state.status;
  sessionDot.classList.toggle("is-live", isRunning);
  sessionDot.classList.toggle("is-error", isError);
  sessionTitle.textContent = isRunning
    ? "接收窗口已开启"
    : isError
      ? "本地程序连接失败"
      : "接收窗口已关闭";
  sessionMessage.textContent = state.statusMessage;
  accessPanel.hidden = !(isRunning && primaryAddress);
  receivedCount.textContent = String(items.length);
  clearButton.disabled = items.length === 0;
  renderItems(items);

  if (isRunning && primaryAddress) {
    receiverMobileUrl.textContent = primaryAddress.displayUrl || primaryAddress.url;
    receiverMobileUrl.title = primaryAddress.url;
    receiverNetworkNote.textContent =
      state.mobileUrls.length > 1
        ? `检测到 ${state.mobileUrls.length} 个网络地址，二维码使用首选地址`
        : "手机和 Mac 需要连接同一局域网";
    receiverSaveNote.textContent = state.downloadDirectory
      ? `文件保存到 ${state.downloadDirectory}`
      : "文件保存到 ~/Documents/局域网互传";
    drawQrCode(primaryAddress.url);
  } else {
    lastQrUrl = "";
  }

  window.clearInterval(timerId);
  updateCountdown();
  if (isRunning) {
    timerId = window.setInterval(updateCountdown, 1000);
  }
}

async function refreshState() {
  try {
    render(await sendMessage({ type: "get_receiver_state" }));
  } catch (error) {
    showToast(error.message, true);
  }
}

async function deleteItem(id) {
  try {
    render(await sendMessage({ type: "delete_item", id }));
  } catch (error) {
    showToast(error.message, true);
  }
}

async function revealItem(id) {
  try {
    render(await sendMessage({ type: "reveal_item", id }));
    showToast("已在访达中显示");
  } catch (error) {
    showToast(error.message, true);
  }
}

clearButton.addEventListener("click", async () => {
  if (
    !window.confirm(
      "只清空当前会话记录，已保存到“文稿/局域网互传”的图片和文件不会删除。继续吗？"
    )
  ) {
    return;
  }

  try {
    render(await sendMessage({ type: "clear_items" }));
    showToast("会话记录已清空，已保存文件未删除");
  } catch (error) {
    showToast(error.message, true);
  }
});

receiverCopyUrlButton.addEventListener("click", async () => {
  const url = currentState?.mobileUrls?.[0]?.url;
  if (!url) {
    return;
  }

  try {
    await navigator.clipboard.writeText(url);
    showToast("手机访问地址已复制");
  } catch (_error) {
    showToast("复制失败，请手动选择地址", true);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "receiver_state_updated") {
    refreshState();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "session" && changes.receiverState?.newValue) {
    render(changes.receiverState.newValue);
  }
});

sendMessage({ type: "receiver_page_ready" }).then(render).catch(refreshState);

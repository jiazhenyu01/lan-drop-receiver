"use strict";

const powerButton = document.getElementById("powerButton");
const switchTitle = document.getElementById("switchTitle");
const statusMessage = document.getElementById("statusMessage");
const statusLamp = document.getElementById("statusLamp");
const activePanel = document.getElementById("activePanel");
const countdown = document.getElementById("countdown");
const qrCanvas = document.getElementById("qrCanvas");
const mobileUrl = document.getElementById("mobileUrl");
const networkNote = document.getElementById("networkNote");
const saveNote = document.getElementById("saveNote");
const copyUrlButton = document.getElementById("copyUrlButton");
const itemCount = document.getElementById("itemCount");
const openReceiverButton = document.getElementById("openReceiverButton");
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
  const cellSize = Math.max(2, Math.floor(132 / (moduleCount + quietZone * 2)));
  const logicalSize = (moduleCount + quietZone * 2) * cellSize;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);

  qrCanvas.width = logicalSize * ratio;
  qrCanvas.height = logicalSize * ratio;
  qrCanvas.style.width = `${logicalSize}px`;
  qrCanvas.style.height = `${logicalSize}px`;

  const context = qrCanvas.getContext("2d");
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

function updateTimer() {
  if (!currentState || currentState.status !== "running") {
    countdown.textContent = "00:00";
    return;
  }
  countdown.textContent = formatCountdown(currentState.expiresAt);
}

function render(state) {
  currentState = state;
  const isRunning = state.status === "running";
  const isStarting = state.status === "starting";
  const isError = state.status === "error";
  const primaryAddress = state.mobileUrls?.[0];

  document.body.dataset.status = state.status;
  powerButton.disabled = isStarting;
  powerButton.setAttribute("aria-pressed", String(isRunning));
  powerButton.querySelector("em").textContent = isRunning ? "ON" : isStarting ? "…" : "OFF";
  switchTitle.textContent = isRunning
    ? "允许局域网接收"
    : isStarting
      ? "正在建立接收窗口"
      : isError
        ? "启动出现问题"
        : "接收已关闭";
  statusMessage.textContent = state.statusMessage;
  statusLamp.classList.toggle("is-live", isRunning);
  statusLamp.classList.toggle("is-error", isError);
  activePanel.hidden = !isRunning;
  itemCount.textContent = String(state.items?.length || 0);
  openReceiverButton.disabled = isStarting;

  if (isRunning && primaryAddress) {
    mobileUrl.textContent = primaryAddress.displayUrl || primaryAddress.url;
    mobileUrl.title = primaryAddress.url;
    networkNote.textContent =
      state.mobileUrls.length > 1
        ? `检测到 ${state.mobileUrls.length} 个网络地址，二维码使用首选地址`
        : "手机和 Mac 需要连接同一局域网";
    saveNote.textContent = state.downloadDirectory
      ? `文件保存到 ${state.downloadDirectory}`
      : "文件保存到 ~/Documents/局域网互传";
    drawQrCode(primaryAddress.url);
  } else {
    lastQrUrl = "";
  }

  window.clearInterval(timerId);
  if (isRunning) {
    updateTimer();
    timerId = window.setInterval(updateTimer, 1000);
  }
}

async function refreshState() {
  try {
    render(await sendMessage({ type: "get_receiver_state" }));
  } catch (error) {
    showToast(error.message, true);
  }
}

powerButton.addEventListener("click", async () => {
  powerButton.disabled = true;
  try {
    const state =
      currentState?.status === "running"
        ? await sendMessage({ type: "stop_receiver" })
        : await sendMessage({ type: "start_receiver" });
    render(state);
  } catch (error) {
    showToast(error.message, true);
    await refreshState();
  }
});

copyUrlButton.addEventListener("click", async () => {
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

openReceiverButton.addEventListener("click", async () => {
  try {
    await sendMessage({ type: "open_receiver_page" });
    window.close();
  } catch (error) {
    showToast(error.message, true);
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

refreshState();

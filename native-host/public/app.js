"use strict";

const TOKEN_STORAGE_KEY = "lanDropSessionToken";
const connectionStatus = document.getElementById("connectionStatus");
const textInput = document.getElementById("textInput");
const textCounter = document.getElementById("textCounter");
const sendTextButton = document.getElementById("sendTextButton");
const imageInput = document.getElementById("imageInput");
const fileInput = document.getElementById("fileInput");
const selectedFiles = document.getElementById("selectedFiles");
const sendFilesButton = document.getElementById("sendFilesButton");
const fileLimit = document.getElementById("fileLimit");
const dropZone = document.getElementById("dropZone");
const toast = document.getElementById("toast");
const downloadFiles = document.getElementById("downloadFiles");
const downloadStatus = document.getElementById("downloadStatus");
const refreshFiles = document.getElementById("refreshFiles");
let downloadTimer;
let loadingDownloads = false;
let downloadSignature = "";

let limits = {
  maxTextBytes: 64 * 1024,
  maxFileBytes: 100 * 1024 * 1024,
  maxSessionBytes: 500 * 1024 * 1024
};
let pendingFiles = [];
let toastTimer = null;

const hashParams = new URLSearchParams(window.location.hash.slice(1));
const hashToken = hashParams.get("token");
if (hashToken) {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, hashToken);
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}
const sessionToken = hashToken || sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";

function showToast(message, isError) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle("is-error", Boolean(isError));
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function setConnection(status, label) {
  connectionStatus.dataset.status = status;
  connectionStatus.querySelector("strong").textContent = label;
}

async function readError(response) {
  try {
    const data = await response.json();
    return data.message || `请求失败（${response.status}）`;
  } catch (_error) {
    return `请求失败（${response.status}）`;
  }
}

async function loadConfig() {
  if (!sessionToken) {
    setConnection("error", "链接已失效");
    throw new Error("访问链接缺少接收密钥，请重新扫描 Mac 上的二维码");
  }

  const response = await fetch("/api/config", {
    cache: "no-store", headers: { "X-Session-Token": sessionToken }
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const data = await response.json();
  limits = { ...limits, ...(data.limits || {}) };
  fileLimit.textContent = `单个 ${formatBytes(limits.maxFileBytes)}`;
  updateTextCounter();
  setConnection("live", "已连接");
}

// Poll metadata only; each file is downloaded by the browser without buffering it in JavaScript.
async function loadDownloads() {
  if (loadingDownloads) return;
  window.clearTimeout(downloadTimer);
  if (!sessionToken) {
    downloadStatus.textContent = "请重新扫描电脑上的二维码";
    return;
  }
  loadingDownloads = true;
  refreshFiles.disabled = true;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10000);
  let retry = true;
  try {
    const response = await fetch("/api/outgoing", {
      cache: "no-store", headers: { "X-Session-Token": sessionToken }, signal: controller.signal
    });
    if (response.status === 401) retry = false;
    if (!response.ok) throw new Error(await readError(response));
    const data = await response.json();
    const signature = JSON.stringify(data.items);
    if (signature !== downloadSignature) {
      downloadFiles.replaceChildren();
      for (const item of data.items) {
        const row = document.createElement("div");
        row.className = "download-file";
        const info = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent = item.name;
        const size = document.createElement("span");
        size.textContent = formatBytes(item.size);
        info.append(name, size);
        const link = document.createElement("a");
        link.textContent = "下载";
        link.download = item.name;
        link.href = `/api/outgoing/${encodeURIComponent(item.id)}?key=${encodeURIComponent(sessionToken)}`;
        row.append(info, link);
        downloadFiles.append(row);
      }
      downloadSignature = signature;
    }
    downloadStatus.textContent = data.items.length
      ? `${data.items.length} 个文件可下载`
      : "等待电脑发送文件，列表会自动更新";
    setConnection("live", "已连接");
  } catch (error) {
    downloadFiles.replaceChildren();
    downloadSignature = "";
    downloadStatus.textContent = retry
      ? "连接中断或会话已结束，请确认电脑已开启传输；重新开启后请重新扫码。"
      : error.message;
    setConnection("error", "无法连接");
  } finally {
    window.clearTimeout(timeout);
    loadingDownloads = false;
    refreshFiles.disabled = false;
    if (retry) downloadTimer = window.setTimeout(loadDownloads, 3000);
  }
}

function updateTextCounter() {
  const size = new TextEncoder().encode(textInput.value).length;
  textCounter.textContent = `${formatBytes(size)} / ${formatBytes(limits.maxTextBytes)}`;
  textCounter.classList.toggle("is-over", size > limits.maxTextBytes);
  sendTextButton.disabled = !textInput.value.trim() || size > limits.maxTextBytes;
}

async function sendText() {
  const text = textInput.value;
  if (!text.trim()) {
    return;
  }

  sendTextButton.disabled = true;
  sendTextButton.querySelector("span").textContent = "正在发送…";

  try {
    const response = await fetch("/api/text", {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Token": sessionToken
      },
      body: JSON.stringify({ text })
    });
    if (!response.ok) {
      throw new Error(await readError(response));
    }
    textInput.value = "";
    updateTextCounter();
    showToast("文本已发送到 Mac");
  } catch (error) {
    setConnection("error", "连接异常");
    showToast(error.message, true);
  } finally {
    sendTextButton.querySelector("span").textContent = "发送文本";
    updateTextCounter();
  }
}

function addFiles(fileList) {
  const incoming = Array.from(fileList || []);
  const known = new Set(pendingFiles.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
  incoming.forEach((file) => {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (!known.has(key)) {
      pendingFiles.push(file);
      known.add(key);
    }
  });
  renderFiles();
}

function removeFile(index) {
  pendingFiles.splice(index, 1);
  renderFiles();
}

function renderFiles(progressByIndex) {
  selectedFiles.replaceChildren();
  selectedFiles.hidden = pendingFiles.length === 0;
  sendFilesButton.disabled = pendingFiles.length === 0;

  pendingFiles.forEach((file, index) => {
    const row = document.createElement("div");
    row.className = "selected-file";
    const info = document.createElement("div");
    const name = document.createElement("strong");
    const meta = document.createElement("span");
    const progress = document.createElement("i");
    const remove = document.createElement("button");

    name.textContent = file.name;
    meta.textContent = `${file.type || "未知类型"} · ${formatBytes(file.size)}`;
    progress.style.width = `${progressByIndex?.[index] || 0}%`;
    remove.type = "button";
    remove.textContent = "移除";
    remove.addEventListener("click", () => removeFile(index));
    info.append(name, meta);
    row.append(info, remove, progress);
    selectedFiles.append(row);
  });
}

function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    if (file.size > limits.maxFileBytes) {
      reject(new Error(`${file.name} 超过 ${formatBytes(limits.maxFileBytes)}`));
      return;
    }

    const request = new XMLHttpRequest();
    request.open("POST", "/api/upload");
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    request.setRequestHeader("X-Session-Token", sessionToken);
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });
    request.addEventListener("load", () => {
      let payload = {};
      try {
        payload = JSON.parse(request.responseText || "{}");
      } catch (_error) {
        // Keep the generic response below.
      }

      if (request.status >= 200 && request.status < 300) {
        onProgress(100);
        resolve(payload);
      } else {
        reject(new Error(payload.message || `上传失败（${request.status}）`));
      }
    });
    request.addEventListener("error", () => reject(new Error("网络连接中断")));
    request.addEventListener("abort", () => reject(new Error("上传已取消")));
    request.send(file);
  });
}

async function sendFiles() {
  if (!pendingFiles.length) {
    return;
  }

  const totalSize = pendingFiles.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > limits.maxSessionBytes) {
    showToast(`所选文件超过本次会话上限 ${formatBytes(limits.maxSessionBytes)}`, true);
    return;
  }

  const filesToSend = [...pendingFiles];
  const progress = {};
  sendFilesButton.disabled = true;
  sendFilesButton.querySelector("span").textContent = `正在发送 0 / ${filesToSend.length}`;

  try {
    for (let index = 0; index < filesToSend.length; index += 1) {
      await uploadFile(filesToSend[index], (value) => {
        progress[index] = value;
        renderFiles(progress);
        sendFilesButton.disabled = true;
      });
      sendFilesButton.querySelector("span").textContent =
        `正在发送 ${index + 1} / ${filesToSend.length}`;
    }
    pendingFiles = [];
    imageInput.value = "";
    fileInput.value = "";
    renderFiles();
    showToast(`${filesToSend.length} 个文件已保存到 Mac 的“文稿/局域网互传”`);
  } catch (error) {
    setConnection("error", "连接异常");
    showToast(error.message, true);
    renderFiles(progress);
  } finally {
    sendFilesButton.querySelector("span").textContent = "发送所选内容";
    sendFilesButton.disabled = pendingFiles.length === 0;
  }
}

textInput.addEventListener("input", updateTextCounter);
sendTextButton.addEventListener("click", sendText);
imageInput.addEventListener("change", () => addFiles(imageInput.files));
fileInput.addEventListener("change", () => addFiles(fileInput.files));
sendFilesButton.addEventListener("click", sendFiles);
refreshFiles.addEventListener("click", loadDownloads);
loadDownloads();

["dragenter", "dragover"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
});
["dragleave", "drop"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  });
});
dropZone.addEventListener("drop", (event) => addFiles(event.dataTransfer.files));

loadConfig().catch((error) => {
  setConnection("error", "无法连接");
  showToast(error.message, true);
  sendTextButton.disabled = true;
  sendFilesButton.disabled = true;
});

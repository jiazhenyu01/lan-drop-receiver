"use strict";

const HOST_NAME = "com.codex.lan_drop_receiver";
const STATE_KEY = "receiverState";
const DEFAULT_DURATION_SECONDS = 10 * 60;

function createDefaultState(overrides) {
  return {
    status: "stopped",
    statusMessage: "接收服务未开启",
    mobileUrls: [],
    downloadDirectory: "",
    expiresAt: 0,
    startedAt: 0,
    items: [],
    limits: {
      maxTextBytes: 64 * 1024,
      maxFileBytes: 100 * 1024 * 1024,
      maxSessionBytes: 500 * 1024 * 1024
    },
    ...(overrides || {})
  };
}

let receiverState = createDefaultState();
let nativePort = null;
let receiverTabId = null;
let stateQueue = Promise.resolve();
const pendingNativeActions = new Map();

const stateReady = chrome.storage.session.get([STATE_KEY]).then((stored) => {
  if (stored[STATE_KEY] && typeof stored[STATE_KEY] === "object") {
    receiverState = createDefaultState(stored[STATE_KEY]);
  }

  if (receiverState.status !== "stopped") {
    receiverState = createDefaultState({
      statusMessage: "浏览器已重新载入，请重新开启接收"
    });
  }

  return chrome.storage.session.set({ [STATE_KEY]: receiverState });
});

function cloneState() {
  return JSON.parse(JSON.stringify(receiverState));
}

function enqueueStateUpdate(update) {
  stateQueue = stateQueue
    .then(stateReady)
    .then(async () => {
      await update();
      await chrome.storage.session.set({ [STATE_KEY]: receiverState });
      chrome.runtime.sendMessage({ type: "receiver_state_updated" }).catch(() => {});
    })
    .catch((error) => {
      console.error("State update failed:", error);
    });

  return stateQueue;
}

async function ensureReceiverTab(focus) {
  if (receiverTabId !== null) {
    try {
      await chrome.tabs.get(receiverTabId);
      if (focus) {
        await chrome.tabs.update(receiverTabId, { active: true });
      }
      return receiverTabId;
    } catch (_error) {
      receiverTabId = null;
    }
  }

  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL("receiver.html"),
    active: Boolean(focus)
  });
  receiverTabId = tab.id ?? null;
  return receiverTabId;
}

function disconnectNativePort() {
  if (!nativePort) {
    return;
  }

  const port = nativePort;
  nativePort = null;
  pendingNativeActions.forEach(({ reject, timer }) => {
    clearTimeout(timer);
    reject(new Error("本地接收程序已断开"));
  });
  pendingNativeActions.clear();

  try {
    port.disconnect();
  } catch (_error) {
    // The native process may already have exited.
  }
}

function requestNativeAction(type, payload) {
  if (!nativePort) {
    return Promise.reject(new Error("接收服务未开启"));
  }

  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingNativeActions.delete(requestId);
      reject(new Error("本地操作超时"));
    }, 5000);

    pendingNativeActions.set(requestId, { resolve, reject, timer });
    try {
      nativePort.postMessage({ type, requestId, ...(payload || {}) });
    } catch (error) {
      clearTimeout(timer);
      pendingNativeActions.delete(requestId);
      reject(error);
    }
  });
}

function handleNativeMessage(message) {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "started") {
    enqueueStateUpdate(async () => {
      receiverState = createDefaultState({
        status: "running",
        statusMessage: "正在接收",
        mobileUrls: Array.isArray(message.mobileUrls) ? message.mobileUrls : [],
        downloadDirectory: String(message.downloadDirectory || ""),
        expiresAt: Number(message.expiresAt) || 0,
        startedAt: Date.now(),
        limits: {
          ...receiverState.limits,
          ...(message.limits || {})
        },
        items: []
      });
      await ensureReceiverTab(true);
    });
    return;
  }

  if (message.type === "item_received" && message.item) {
    enqueueStateUpdate(async () => {
      const nextItems = [
        message.item,
        ...receiverState.items.filter((item) => item.id !== message.item.id)
      ].slice(0, 100);
      receiverState = {
        ...receiverState,
        items: nextItems,
        statusMessage: `已收到 ${nextItems.length} 项内容`
      };
    });
    return;
  }

  if (message.type === "item_deleted" && message.id) {
    enqueueStateUpdate(async () => {
      receiverState = {
        ...receiverState,
        items: receiverState.items.filter((item) => item.id !== message.id)
      };
    });
    return;
  }

  if (message.type === "items_cleared") {
    enqueueStateUpdate(async () => {
      receiverState = {
        ...receiverState,
        items: [],
        statusMessage: receiverState.status === "running" ? "正在接收" : "接收服务未开启"
      };
    });
    return;
  }

  if (message.type === "stopped") {
    enqueueStateUpdate(async () => {
      const reasonText =
        message.reason === "timeout"
          ? "接收时间已到，已保存文件仍保留在“文稿/局域网互传”"
          : "接收已关闭，已保存文件仍保留在“文稿/局域网互传”";
      receiverState = createDefaultState({ statusMessage: reasonText });
      disconnectNativePort();
    });
    return;
  }

  if (message.type === "action_result" && message.requestId) {
    const pending = pendingNativeActions.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingNativeActions.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve();
    } else {
      pending.reject(new Error(message.error || "本地操作失败"));
    }
    return;
  }

  if (message.type === "error") {
    enqueueStateUpdate(async () => {
      receiverState = {
        ...receiverState,
        status: "error",
        statusMessage: message.message || "本地接收程序发生错误"
      };
    });
  }
}

function connectNativeHost() {
  if (nativePort) {
    return nativePort;
  }

  const port = chrome.runtime.connectNative(HOST_NAME);
  nativePort = port;

  port.onMessage.addListener(handleNativeMessage);
  port.onDisconnect.addListener(() => {
    const errorMessage = chrome.runtime.lastError?.message;
    if (nativePort === port) {
      nativePort = null;
    }
    pendingNativeActions.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(new Error(errorMessage || "本地接收程序已退出"));
    });
    pendingNativeActions.clear();

    enqueueStateUpdate(async () => {
      if (receiverState.status === "stopped") {
        return;
      }

      receiverState = createDefaultState({
        status: errorMessage ? "error" : "stopped",
        statusMessage: errorMessage
          ? `无法连接本地接收程序：${errorMessage}`
          : "本地接收程序已退出"
      });
    });
  });

  return port;
}

async function startReceiver() {
  await stateReady;

  if (receiverState.status === "running" || receiverState.status === "starting") {
    return cloneState();
  }

  await enqueueStateUpdate(async () => {
    receiverState = createDefaultState({
      status: "starting",
      statusMessage: "正在启动本地接收程序…"
    });
  });

  try {
    const port = connectNativeHost();
    port.postMessage({
      type: "start",
      durationSeconds: DEFAULT_DURATION_SECONDS,
      limits: receiverState.limits
    });
  } catch (error) {
    await enqueueStateUpdate(async () => {
      receiverState = createDefaultState({
        status: "error",
        statusMessage: `启动失败：${error.message}`
      });
    });
  }

  return cloneState();
}

async function stopReceiver() {
  await stateReady;

  if (nativePort) {
    try {
      nativePort.postMessage({ type: "stop" });
      return cloneState();
    } catch (_error) {
      disconnectNativePort();
    }
  }

  await enqueueStateUpdate(async () => {
    receiverState = createDefaultState({
      statusMessage: "接收已关闭"
    });
  });
  return cloneState();
}

async function deleteItem(id) {
  await stateReady;
  const item = receiverState.items.find((candidate) => candidate.id === id);
  if (!item) {
    return cloneState();
  }

  await enqueueStateUpdate(async () => {
    receiverState = {
      ...receiverState,
      items: receiverState.items.filter((candidate) => candidate.id !== id)
    };
  });

  if (item.kind !== "text" && nativePort) {
    nativePort.postMessage({ type: "delete_item", id });
  }

  return cloneState();
}

async function revealItem(id) {
  await stateReady;
  const item = receiverState.items.find((candidate) => candidate.id === id);
  if (!item || item.kind === "text") {
    throw new Error("找不到对应的文件记录");
  }
  await requestNativeAction("reveal_item", { id });
  return cloneState();
}

async function clearItems() {
  await stateReady;

  if (nativePort) {
    nativePort.postMessage({ type: "clear_items" });
  }

  await enqueueStateUpdate(async () => {
    receiverState = {
      ...receiverState,
      items: []
    };
  });
  return cloneState();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  const respond = (operation) => {
    Promise.resolve(operation)
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
  };

  if (message.type === "get_receiver_state") {
    respond(stateReady.then(cloneState));
    return true;
  }

  if (message.type === "start_receiver") {
    respond(startReceiver());
    return true;
  }

  if (message.type === "stop_receiver") {
    respond(stopReceiver());
    return true;
  }

  if (message.type === "open_receiver_page") {
    respond(
      stateReady.then(async () => {
        await ensureReceiverTab(true);
        return cloneState();
      })
    );
    return true;
  }

  if (message.type === "receiver_page_ready") {
    receiverTabId = sender.tab?.id ?? receiverTabId;
    respond(stateReady.then(cloneState));
    return true;
  }

  if (message.type === "delete_item") {
    respond(deleteItem(message.id));
    return true;
  }

  if (message.type === "clear_items") {
    respond(clearItems());
    return true;
  }

  if (message.type === "reveal_item") {
    respond(revealItem(message.id));
    return true;
  }

  return false;
});

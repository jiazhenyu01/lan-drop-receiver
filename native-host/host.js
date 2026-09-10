#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { createReceiverSession } = require("./server.js");

const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
let inputBuffer = Buffer.alloc(0);
let session = null;
let exiting = false;

function sendNativeMessage(message) {
  if (exiting) {
    return;
  }

  try {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    process.stdout.write(Buffer.concat([header, body]));
  } catch (error) {
    process.stderr.write(`Native response failed: ${error.message}\n`);
  }
}

function scheduleExit() {
  if (exiting) {
    return;
  }
  exiting = true;
  setTimeout(() => process.exit(0), 80);
}

async function handleMessage(message) {
  if (!message || typeof message.type !== "string") {
    sendNativeMessage({ type: "error", message: "消息格式无效" });
    return;
  }

  if (message.type === "start") {
    if (session && !session.stopped) {
      sendNativeMessage({ type: "started", ...session.started });
      return;
    }

    try {
      session = await createReceiverSession({
        host: "0.0.0.0",
        durationSeconds: message.durationSeconds,
        limits: message.limits,
        downloadDirectory: process.env.LAN_DROP_DOWNLOAD_DIR || undefined,
        staticRoot: path.join(__dirname, "public"),
        onItem(item) {
          sendNativeMessage({ type: "item_received", item });
        },
        onStopped(reason) {
          sendNativeMessage({ type: "stopped", reason });
          scheduleExit();
        },
        onError(error) {
          sendNativeMessage({ type: "error", message: error.message });
        }
      });
      sendNativeMessage({ type: "started", ...session.started });
    } catch (error) {
      sendNativeMessage({ type: "error", message: `启动接收服务失败：${error.message}` });
      scheduleExit();
    }
    return;
  }

  if (message.type === "stop") {
    if (session) {
      await session.stop("manual");
    } else {
      sendNativeMessage({ type: "stopped", reason: "manual" });
      scheduleExit();
    }
    return;
  }

  if (message.type === "delete_item") {
    if (!session) {
      return;
    }
    await session.deleteItem(String(message.id || ""));
    sendNativeMessage({ type: "item_deleted", id: message.id });
    return;
  }

  if (message.type === "clear_items") {
    if (!session) {
      return;
    }
    await session.clearItems();
    sendNativeMessage({ type: "items_cleared" });
    return;
  }

  if (message.type === "reveal_item") {
    try {
      if (!session) {
        throw new Error("接收会话已结束");
      }
      const revealed = await session.revealItem(String(message.id || ""));
      if (!revealed) {
        throw new Error("找不到对应的文件记录");
      }
      sendNativeMessage({
        type: "action_result",
        requestId: message.requestId,
        ok: true
      });
    } catch (error) {
      sendNativeMessage({
        type: "action_result",
        requestId: message.requestId,
        ok: false,
        error: `无法在访达中显示文件：${error.message}`
      });
    }
  }
}

function parseInput() {
  while (inputBuffer.length >= 4) {
    const messageLength = inputBuffer.readUInt32LE(0);
    if (messageLength > MAX_MESSAGE_BYTES) {
      sendNativeMessage({ type: "error", message: "Native Messaging 消息过大" });
      scheduleExit();
      return;
    }
    if (inputBuffer.length < 4 + messageLength) {
      return;
    }

    const body = inputBuffer.subarray(4, 4 + messageLength);
    inputBuffer = inputBuffer.subarray(4 + messageLength);

    let message;
    try {
      message = JSON.parse(body.toString("utf8"));
    } catch (_error) {
      sendNativeMessage({ type: "error", message: "Native Messaging JSON 无效" });
      continue;
    }

    handleMessage(message).catch((error) => {
      sendNativeMessage({ type: "error", message: error.message });
    });
  }
}

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  parseInput();
});

process.stdin.on("end", async () => {
  exiting = true;
  if (session && !session.stopped) {
    await session.stop("parent_closed").catch(() => {});
  }
  process.exit(0);
});

process.stdin.on("error", (error) => {
  process.stderr.write(`Native input failed: ${error.message}\n`);
});

process.on("SIGTERM", async () => {
  exiting = true;
  if (session && !session.stopped) {
    await session.stop("terminated").catch(() => {});
  }
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  process.stderr.write(`Uncaught exception: ${error.stack || error.message}\n`);
  sendNativeMessage({ type: "error", message: "本地接收程序意外退出" });
  scheduleExit();
});

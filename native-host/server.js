"use strict";

const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const SAFE_PREVIEW_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif"
]);

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function normalizeLimits(input) {
  const limits = input || {};
  return {
    maxTextBytes: clampInteger(limits.maxTextBytes, 1024, 1024 * 1024, 64 * 1024),
    maxFileBytes: clampInteger(
      limits.maxFileBytes,
      1024,
      1024 * 1024 * 1024,
      100 * 1024 * 1024
    ),
    maxSessionBytes: clampInteger(
      limits.maxSessionBytes,
      1024,
      5 * 1024 * 1024 * 1024,
      500 * 1024 * 1024
    )
  };
}

function defaultDownloadDirectory(homeDirectory) {
  const resolvedHome =
    typeof homeDirectory === "string" && homeDirectory
      ? homeDirectory
      : os.homedir();
  return path.join(resolvedHome, "Documents", "局域网互传");
}

function isPrivateIPv4(address) {
  if (/^10\./.test(address) || /^192\.168\./.test(address)) {
    return true;
  }
  const match = /^172\.(\d+)\./.exec(address);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function getNetworkAddresses() {
  const records = [];
  const interfaces = os.networkInterfaces();

  Object.entries(interfaces).forEach(([name, addresses]) => {
    (addresses || []).forEach((entry) => {
      const isIPv4 = entry.family === "IPv4" || entry.family === 4;
      if (!isIPv4 || entry.internal || entry.address.startsWith("169.254.")) {
        return;
      }
      records.push({
        name,
        address: entry.address,
        private: isPrivateIPv4(entry.address)
      });
    });
  });

  records.sort((left, right) => {
    const leftPreferred = /^(en0|en1|wi-?fi)$/i.test(left.name) ? 1 : 0;
    const rightPreferred = /^(en0|en1|wi-?fi)$/i.test(right.name) ? 1 : 0;
    return Number(right.private) - Number(left.private) || rightPreferred - leftPreferred;
  });

  const unique = new Map();
  records.forEach((record) => unique.set(record.address, record));
  return Array.from(unique.values());
}

function secureEqual(expected, actual) {
  if (typeof actual !== "string") {
    return false;
  }
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return (
    expectedBuffer.length === actualBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

function sendJson(response, statusCode, payload) {
  if (response.writableEnded) {
    return;
  }
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  response.end(JSON.stringify(payload));
}

function truncateUtf8(value, maximumBytes) {
  let result = "";
  let size = 0;
  for (const character of value) {
    const characterSize = Buffer.byteLength(character, "utf8");
    if (size + characterSize > maximumBytes) {
      break;
    }
    result += character;
    size += characterSize;
  }
  return result;
}

function safeFileName(rawName) {
  const decoded = String(rawName || "file");
  const base = path.basename(decoded).normalize("NFC");
  let cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/:\\]/g, "_")
    .trim();
  cleaned = cleaned || "未命名文件";
  if (cleaned === "." || cleaned === "..") {
    cleaned = "未命名文件";
  }
  if (/^\.lan-drop-.*\.part$/i.test(cleaned)) {
    cleaned = `_${cleaned}`;
  }

  const extension = path.extname(cleaned);
  if (
    Buffer.byteLength(cleaned, "utf8") > 200 &&
    extension &&
    Buffer.byteLength(extension, "utf8") <= 40
  ) {
    const stem = cleaned.slice(0, cleaned.length - extension.length);
    return `${truncateUtf8(stem, 200 - Buffer.byteLength(extension, "utf8"))}${extension}`;
  }
  return truncateUtf8(cleaned, 200) || "未命名文件";
}

function contentDisposition(fileName, disposition = "inline") {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(/['()]/g, escape);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function getRemoteAddress(request) {
  const value = request.socket.remoteAddress || "局域网设备";
  return value.replace(/^::ffff:/, "");
}

function readBody(request, maximumBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) {
        resolve({ tooLarge: true, size });
        return;
      }
      resolve({ tooLarge: false, size, body: Buffer.concat(chunks) });
    });
    request.on("aborted", () => reject(new Error("Request aborted")));
    request.on("error", reject);
  });
}

function getStaticContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

async function cleanStalePartialFiles(downloadDirectory) {
  let entries = [];
  try {
    entries = await fsp.readdir(downloadDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          /^\.lan-drop-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/i.test(
            entry.name
          )
      )
      .map((entry) => fsp.unlink(path.join(downloadDirectory, entry.name)).catch(() => {}))
  );
}

async function publishWithoutOverwrite(partialPath, downloadDirectory, requestedName) {
  const extension = path.extname(requestedName);
  const stem = requestedName.slice(0, requestedName.length - extension.length) || "未命名文件";

  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const savedName =
      suffix === 0 ? requestedName : `${stem} (${suffix})${extension}`;
    const savedPath = path.join(downloadDirectory, savedName);

    try {
      await fsp.link(partialPath, savedPath);
      try {
        await fsp.unlink(partialPath);
      } catch (error) {
        await fsp.unlink(savedPath).catch(() => {});
        throw error;
      }
      return { savedName, savedPath };
    } catch (error) {
      if (error.code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }

  throw new Error("同名文件过多，无法生成安全的保存名称");
}

function revealInFinder(filePath) {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/open", ["-R", filePath], (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function createReceiverSession(options) {
  const settings = options || {};
  const limits = normalizeLimits(settings.limits);
  const durationSeconds = clampInteger(settings.durationSeconds, 60, 60 * 60, 10 * 60);
  const sessionToken = crypto.randomBytes(32).toString("hex");
  const localAccessToken = crypto.randomBytes(32).toString("hex");
  const desktopToken = crypto.randomBytes(32).toString("hex");
  const downloadDirectory = path.resolve(
    settings.downloadDirectory || defaultDownloadDirectory()
  );
  const staticRoot = path.resolve(settings.staticRoot || path.join(__dirname, "public"));
  const items = new Map();
  const outgoing = new Map();
  const uploads = new Set();
  let outgoingDirectory;
  const partialFiles = new Set();
  const rateLimits = new Map();

  let server;
  let timer;
  let stopped = false;
  let stoppingPromise = null;
  let activeReservedBytes = 0;
  let completedSessionBytes = 0;

  function totalStoredBytes() {
    return completedSessionBytes;
  }

  function isAuthorized(request) {
    return secureEqual(sessionToken, request.headers["x-session-token"]);
  }

  function isDesktop(request) {
    return ["127.0.0.1", "::1"].includes(getRemoteAddress(request)) &&
      secureEqual(desktopToken, request.headers["x-desktop-token"]);
  }

  function outgoingItem(item) {
    return { id: item.id, name: item.name, size: item.size };
  }

  function checkRateLimit(request) {
    const address = getRemoteAddress(request);
    const now = Date.now();
    const current = rateLimits.get(address);

    if (!current || now - current.startedAt >= 60_000) {
      rateLimits.set(address, { startedAt: now, count: 1 });
      return true;
    }

    current.count += 1;
    return current.count <= 20;
  }

  function createPublicItem(item, port) {
    const base = `http://127.0.0.1:${port}/api/items/${encodeURIComponent(item.id)}`;
    const key = `key=${encodeURIComponent(localAccessToken)}`;
    return {
      id: item.id,
      kind: item.kind,
      name: item.name,
      mime: item.mime,
      size: item.size,
      receivedAt: item.receivedAt,
      remoteAddress: item.remoteAddress,
      viewUrl: `${base}?${key}`,
      savedPath: item.path,
      savedDirectory: downloadDirectory
    };
  }

  async function serveStatic(response, fileName) {
    const filePath = path.resolve(staticRoot, fileName);
    if (!filePath.startsWith(`${staticRoot}${path.sep}`) && filePath !== staticRoot) {
      sendJson(response, 404, { ok: false, message: "Not found" });
      return;
    }

    try {
      const content = await fsp.readFile(filePath);
      response.writeHead(200, {
        "Content-Type": getStaticContentType(filePath),
        "Content-Length": content.length,
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY"
      });
      response.end(content);
    } catch (_error) {
      sendJson(response, 404, { ok: false, message: "Not found" });
    }
  }

  async function handleText(request, response, port) {
    if (!isAuthorized(request)) {
      sendJson(response, 401, { ok: false, message: "接收密钥无效" });
      return;
    }
    if (!checkRateLimit(request)) {
      sendJson(response, 429, { ok: false, message: "发送过于频繁，请稍后再试" });
      return;
    }

    try {
      const result = await readBody(request, limits.maxTextBytes + 1024);
      if (result.tooLarge) {
        sendJson(response, 413, { ok: false, message: "文本内容过大" });
        return;
      }

      let data;
      try {
        data = JSON.parse(result.body.toString("utf8"));
      } catch (_error) {
        sendJson(response, 400, { ok: false, message: "请求内容不是有效 JSON" });
        return;
      }

      if (typeof data.text !== "string" || !data.text.trim()) {
        sendJson(response, 400, { ok: false, message: "文本不能为空" });
        return;
      }

      const textSize = Buffer.byteLength(data.text, "utf8");
      if (textSize > limits.maxTextBytes) {
        sendJson(response, 413, { ok: false, message: "文本内容过大" });
        return;
      }

      const item = {
        id: crypto.randomUUID(),
        kind: "text",
        text: data.text,
        size: textSize,
        receivedAt: Date.now(),
        remoteAddress: getRemoteAddress(request)
      };
      settings.onItem?.(item);
      sendJson(response, 200, { ok: true, id: item.id });
    } catch (error) {
      sendJson(response, 500, { ok: false, message: error.message });
    }
  }

  function handleUpload(request, response, port, toPhone = false) {
    // Both directions share streaming limits; reserve space until atomic publication completes.
    if (!(toPhone ? isDesktop(request) : isAuthorized(request))) {
      sendJson(response, 401, { ok: false, message: "接收密钥无效" });
      request.resume();
      return;
    }
    if (!checkRateLimit(request)) {
      sendJson(response, 429, { ok: false, message: "发送过于频繁，请稍后再试" });
      request.resume();
      return;
    }

    const contentLength = Number(request.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > limits.maxFileBytes) {
      sendJson(response, 413, { ok: false, message: "文件超过单文件大小限制" });
      request.resume();
      return;
    }

    const reservation = Number.isFinite(contentLength) ? contentLength : limits.maxFileBytes;
    if (totalStoredBytes() + activeReservedBytes + reservation > limits.maxSessionBytes) {
      sendJson(response, 413, { ok: false, message: "本次会话的文件总量已达到限制" });
      request.resume();
      return;
    }

    activeReservedBytes += reservation;
    const id = crypto.randomUUID();
    const originalHeader = String(request.headers["x-file-name"] || "file");
    let decodedName;
    try {
      decodedName = decodeURIComponent(originalHeader);
    } catch (_error) {
      decodedName = originalHeader;
    }
    const name = safeFileName(decodedName);
    const mime = String(request.headers["content-type"] || "application/octet-stream")
      .split(";")[0]
      .trim()
      .slice(0, 120);
    const targetDirectory = toPhone ? outgoingDirectory : downloadDirectory;
    const partialPath = path.join(targetDirectory, `.lan-drop-${id}.part`);
    partialFiles.add(partialPath);
    const output = fs.createWriteStream(partialPath, { flags: "wx", mode: 0o600 });
    let finishUpload;
    const uploadDone = new Promise((resolve) => { finishUpload = resolve; });
    uploads.add(uploadDone);
    uploadDone.then(() => uploads.delete(uploadDone));
    output.on("close", () => {
      if (rejected) finishUpload();
    });

    let receivedBytes = 0;
    let rejected = false;
    let reservationReleased = false;

    function releaseReservation() {
      if (!reservationReleased) {
        activeReservedBytes = Math.max(0, activeReservedBytes - reservation);
        reservationReleased = true;
      }
    }

    function removePartialFile() {
      fsp
        .unlink(partialPath)
        .catch(() => {})
        .finally(() => partialFiles.delete(partialPath));
    }

    function rejectUpload(statusCode, message) {
      if (rejected) {
        return;
      }
      rejected = true;
      releaseReservation();
      request.resume();
      output.destroy();
      removePartialFile();
      sendJson(response, statusCode, { ok: false, message });
    }

    output.on("error", (error) => {
      rejectUpload(500, `无法写入接收文件夹：${error.message}`);
    });

    request.on("data", (chunk) => {
      if (rejected) {
        return;
      }
      receivedBytes += chunk.length;
      const projectedTotal =
        totalStoredBytes() + activeReservedBytes - reservation + receivedBytes;

      if (receivedBytes > limits.maxFileBytes) {
        rejectUpload(413, "文件超过单文件大小限制");
        return;
      }
      if (projectedTotal > limits.maxSessionBytes) {
        rejectUpload(413, "本次会话的文件总量已达到限制");
        return;
      }
      if (!output.write(chunk)) {
        request.pause();
        output.once("drain", () => request.resume());
      }
    });

    request.on("end", () => {
      if (rejected) {
        return;
      }
      if (receivedBytes === 0) {
        rejectUpload(400, "文件不能为空");
        return;
      }
      output.end();
    });

    request.on("aborted", () => rejectUpload(499, "上传已中断"));
    request.on("error", (error) => rejectUpload(500, error.message));

    output.on("finish", async () => {
      if (rejected) {
        return;
      }
      try {
        if (stopped) throw new Error("传输会话已结束");
        const published = await publishWithoutOverwrite(
          partialPath,
          targetDirectory,
          name
        );
        partialFiles.delete(partialPath);
        const item = {
          id,
          kind: SAFE_PREVIEW_MIME_TYPES.has(mime) ? "image" : "file",
          name: published.savedName,
          mime,
          size: receivedBytes,
          path: published.savedPath,
          receivedAt: Date.now(),
          remoteAddress: getRemoteAddress(request)
        };
        completedSessionBytes += receivedBytes;
        if (toPhone) {
          outgoing.set(id, item);
          sendJson(response, 200, { ok: true, item: outgoingItem(item) });
          return;
        }
        items.set(id, item);
        const publicItem = createPublicItem(item, port);
        try {
          settings.onItem?.(publicItem);
        } catch (error) {
          settings.onError?.(error);
        }
        sendJson(response, 200, { ok: true, item: publicItem });
      } catch (error) {
        await fsp.unlink(partialPath).catch(() => {});
        partialFiles.delete(partialPath);
        sendJson(response, 500, { ok: false, message: `文件接收失败：${error.message}` });
      } finally {
        releaseReservation();
        finishUpload();
      }
    });
  }

  function handleFileDownload(request, response, requestUrl, toPhone = false) {
    const token = toPhone ? sessionToken : localAccessToken;
    if (!secureEqual(token, requestUrl.searchParams.get("key"))) {
      sendJson(response, 401, { ok: false, message: "Unauthorized" });
      return;
    }

    const prefix = toPhone ? "/api/outgoing/" : "/api/items/";
    const id = requestUrl.pathname.slice(prefix.length);
    const item = (toPhone ? outgoing : items).get(id);
    if (!item) {
      sendJson(response, 404, { ok: false, message: "文件已不存在" });
      return;
    }

    response.writeHead(200, {
      "Content-Type": toPhone ? "application/octet-stream" : item.mime || "application/octet-stream",
      "Content-Length": item.size,
      "Content-Disposition": contentDisposition(item.name, toPhone ? "attachment" : "inline"),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    });
    const stream = fs.createReadStream(item.path);
    response.on("close", () => stream.destroy());
    stream.on("error", () => {
      if (!response.headersSent) {
        sendJson(response, 500, { ok: false, message: "无法读取已保存文件" });
      } else {
        response.destroy();
      }
    });
    stream.pipe(response);
  }

  server = http.createServer(async (request, response) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url, "http://localhost");
    } catch (_error) {
      sendJson(response, 400, { ok: false, message: "Bad request" });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/") {
      await serveStatic(response, "index.html");
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/styles.css") {
      await serveStatic(response, "styles.css");
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/app.js") {
      await serveStatic(response, "app.js");
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/config") {
      if (!isAuthorized(request)) {
        sendJson(response, 401, { ok: false, message: "会话已失效，请重新扫码" });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        limits,
        expiresAt
      });
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/text") {
      await handleText(request, response, server.address().port);
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/upload") {
      handleUpload(request, response, server.address().port);
      return;
    }
    if (requestUrl.pathname === "/api/outgoing") {
      if (request.method === "POST") {
        handleUpload(request, response, server.address().port, true);
        return;
      }
      if (request.method === "GET") {
        if (!isAuthorized(request) && !isDesktop(request)) {
          sendJson(response, 401, { ok: false, message: "会话已失效，请重新扫码" });
          return;
        }
        sendJson(response, 200, { ok: true, items: Array.from(outgoing.values(), outgoingItem) });
        return;
      }
    }
    if (request.method === "GET" && requestUrl.pathname.startsWith("/api/outgoing/")) {
      handleFileDownload(request, response, requestUrl, true);
      return;
    }
    if (request.method === "GET" && requestUrl.pathname.startsWith("/api/items/")) {
      handleFileDownload(request, response, requestUrl);
      return;
    }

    sendJson(response, 404, { ok: false, message: "Not found" });
  });

  server.requestTimeout = 15 * 60 * 1000;
  server.headersTimeout = 30 * 1000;
  server.maxHeadersCount = 40;

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, settings.host || "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
    await fsp.mkdir(downloadDirectory, { recursive: true, mode: 0o700 });
    await cleanStalePartialFiles(downloadDirectory);
    outgoingDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "lan-drop-outgoing-"));
  } catch (error) {
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    throw error;
  }

  const port = server.address().port;
  const networkAddresses = getNetworkAddresses();
  if (!networkAddresses.length) {
    networkAddresses.push({ name: "local", address: "127.0.0.1", private: true });
  }

  const expiresAt = Date.now() + durationSeconds * 1000;
  const mobileUrls = networkAddresses.map((entry) => {
    const displayUrl = `http://${entry.address}:${port}/`;
    return {
      interface: entry.name,
      displayUrl,
      url: `${displayUrl}#token=${sessionToken}`
    };
  });

  async function deleteItem(id) {
    return items.delete(id);
  }

  async function clearItems() {
    items.clear();
  }

  async function revealItem(id) {
    const item = items.get(id);
    if (!item) {
      return false;
    }
    await revealInFinder(item.path);
    return true;
  }

  async function stop(reason) {
    if (stoppingPromise) {
      return stoppingPromise;
    }
    stopped = true;
    stoppingPromise = (async () => {
      clearTimeout(timer);
      await new Promise((resolve) => {
        const fallback = setTimeout(resolve, 1000);
        server.close(() => {
          clearTimeout(fallback);
          resolve();
        });
        server.closeAllConnections?.();
      });
      // Wait for in-flight writes and atomic publication before removing session copies.
      await Promise.all(Array.from(uploads));
      await Promise.all(
        Array.from(partialFiles).map(async (partialPath) => {
          await fsp.unlink(partialPath).catch(() => {});
          partialFiles.delete(partialPath);
        })
      );
      await fsp.rm(outgoingDirectory, { recursive: true, force: true });
      outgoing.clear();
      settings.onStopped?.(reason || "manual");
    })();
    return stoppingPromise;
  }

  timer = setTimeout(() => {
    stop("timeout").catch((error) => settings.onError?.(error));
  }, durationSeconds * 1000);
  timer.unref?.();

  return {
    started: {
      port,
      desktopToken,
      mobileUrls,
      expiresAt,
      limits,
      downloadDirectory
    },
    get stopped() {
      return stopped;
    },
    deleteItem,
    clearItems,
    revealItem,
    stop,
    downloadDirectory
  };
}

module.exports = {
  SAFE_PREVIEW_MIME_TYPES,
  cleanStalePartialFiles,
  createReceiverSession,
  defaultDownloadDirectory,
  getNetworkAddresses,
  normalizeLimits,
  publishWithoutOverwrite,
  safeFileName
};

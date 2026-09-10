"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createReceiverSession,
  defaultDownloadDirectory,
  normalizeLimits,
  safeFileName
} = require("../native-host/server.js");

async function createTestReceiver(context, options) {
  const testRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "lan-drop-receiver-test-"));
  const downloadDirectory = path.join(testRoot, "Downloads", "LAN Drop Receiver");
  const session = await createReceiverSession({
    ...(options || {}),
    downloadDirectory
  });

  context.after(async () => {
    await session.stop("test").catch(() => {});
    await fsp.rm(testRoot, { recursive: true, force: true });
  });

  return { session, downloadDirectory, testRoot };
}

function getSessionAccess(session) {
  const mobileUrl = new URL(session.started.mobileUrls[0].url);
  return {
    baseUrl: `http://127.0.0.1:${session.started.port}`,
    token: new URLSearchParams(mobileUrl.hash.slice(1)).get("token")
  };
}

async function uploadFile(baseUrl, token, name, bytes, mime) {
  return fetch(`${baseUrl}/api/upload`, {
    method: "POST",
    headers: {
      "Content-Type": mime || "application/octet-stream",
      "Content-Length": String(bytes.length),
      "X-File-Name": encodeURIComponent(name),
      "X-Session-Token": token
    },
    body: bytes
  });
}

test("normalizes limits and file names", () => {
  assert.equal(
    defaultDownloadDirectory("/Users/example"),
    path.join("/Users/example", "Documents", "局域网互传")
  );
  assert.deepEqual(normalizeLimits({ maxTextBytes: 1 }), {
    maxTextBytes: 1024,
    maxFileBytes: 100 * 1024 * 1024,
    maxSessionBytes: 500 * 1024 * 1024
  });
  assert.equal(safeFileName("../../报告\u0000.txt"), "报告.txt");
  assert.equal(safeFileName("a/b/c.zip"), "c.zip");
  assert.equal(
    safeFileName(".lan-drop-00000000-0000-0000-0000-000000000000.part"),
    "_.lan-drop-00000000-0000-0000-0000-000000000000.part"
  );
  assert.ok(Buffer.byteLength(safeFileName(`${"报告".repeat(100)}.txt`), "utf8") <= 200);
  assert.match(safeFileName(`${"报告".repeat(100)}.txt`), /\.txt$/);
});

test("receives authenticated text without writing it to a file", async (context) => {
  const received = [];
  const { session, downloadDirectory } = await createTestReceiver(context, {
    durationSeconds: 60,
    onItem: (item) => received.push(item)
  });
  const { baseUrl, token } = getSessionAccess(session);

  const unauthorized = await fetch(`${baseUrl}/api/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "secret" })
  });
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`${baseUrl}/api/text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": token
    },
    body: JSON.stringify({ text: "来自手机的文本" })
  });
  assert.equal(response.status, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].kind, "text");
  assert.equal(received[0].text, "来自手机的文本");
  assert.deepEqual(fs.readdirSync(downloadDirectory), []);
});

test("saves an image in the receive directory and removing its record keeps the file", async (context) => {
  const received = [];
  const { session, downloadDirectory } = await createTestReceiver(context, {
    durationSeconds: 60,
    onItem: (item) => received.push(item)
  });
  const { baseUrl, token } = getSessionAccess(session);
  const imageBytes = Buffer.from("fake-png-bytes");

  const response = await uploadFile(baseUrl, token, "截图.png", imageBytes, "image/png");
  assert.equal(response.status, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].kind, "image");
  assert.equal(received[0].name, "截图.png");
  assert.equal(received[0].savedPath, path.join(downloadDirectory, "截图.png"));
  assert.equal(fs.existsSync(received[0].savedPath), true);

  const preview = await fetch(received[0].viewUrl);
  assert.equal(preview.status, 200);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), imageBytes);

  assert.equal(await session.deleteItem(received[0].id), true);
  const deletedPreview = await fetch(received[0].viewUrl);
  assert.equal(deletedPreview.status, 404);
  assert.equal(fs.existsSync(received[0].savedPath), true);
  assert.deepEqual(fs.readFileSync(received[0].savedPath), imageBytes);
});

test("rejects a file above the configured limit and cleans the partial file", async (context) => {
  const { session, downloadDirectory } = await createTestReceiver(context, {
    durationSeconds: 60,
    limits: {
      maxFileBytes: 1024,
      maxSessionBytes: 4096
    }
  });
  const { baseUrl, token } = getSessionAccess(session);
  const bytes = Buffer.alloc(2048, 1);

  const response = await uploadFile(baseUrl, token, "too-large.bin", bytes);
  assert.equal(response.status, 413);
  assert.deepEqual(fs.readdirSync(downloadDirectory), []);
});

test("same-name uploads never overwrite an existing received file", async (context) => {
  const received = [];
  const { session, downloadDirectory } = await createTestReceiver(context, {
    durationSeconds: 60,
    onItem: (item) => received.push(item)
  });
  const { baseUrl, token } = getSessionAccess(session);

  assert.equal((await uploadFile(baseUrl, token, "报告.txt", Buffer.from("first"))).status, 200);
  assert.equal((await uploadFile(baseUrl, token, "报告.txt", Buffer.from("second"))).status, 200);

  assert.deepEqual(
    fs.readdirSync(downloadDirectory).sort(),
    ["报告 (1).txt", "报告.txt"]
  );
  assert.equal(fs.readFileSync(path.join(downloadDirectory, "报告.txt"), "utf8"), "first");
  assert.equal(fs.readFileSync(path.join(downloadDirectory, "报告 (1).txt"), "utf8"), "second");
  assert.deepEqual(
    received.map((item) => item.name),
    ["报告.txt", "报告 (1).txt"]
  );
});

test("stopping a session keeps completed files", async () => {
  const testRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "lan-drop-receiver-stop-"));
  const downloadDirectory = path.join(testRoot, "Downloads", "LAN Drop Receiver");

  try {
    const received = [];
    const session = await createReceiverSession({
      durationSeconds: 60,
      downloadDirectory,
      onItem: (item) => received.push(item)
    });
    const { baseUrl, token } = getSessionAccess(session);
    const bytes = Buffer.from("persistent");
    assert.equal((await uploadFile(baseUrl, token, "keep.txt", bytes)).status, 200);

    await session.stop("test");

    assert.equal(fs.existsSync(received[0].savedPath), true);
    assert.deepEqual(fs.readFileSync(received[0].savedPath), bytes);
  } finally {
    await fsp.rm(testRoot, { recursive: true, force: true });
  }
});

test("a new session removes stale receiver partials but keeps normal files", async (context) => {
  const testRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "lan-drop-receiver-stale-"));
  const downloadDirectory = path.join(testRoot, "Downloads", "LAN Drop Receiver");
  await fsp.mkdir(downloadDirectory, { recursive: true });
  const stalePartial = path.join(
    downloadDirectory,
    ".lan-drop-00000000-0000-0000-0000-000000000000.part"
  );
  const normalFile = path.join(downloadDirectory, "keep.part");
  await fsp.writeFile(stalePartial, "partial");
  await fsp.writeFile(normalFile, "user file");

  const session = await createReceiverSession({ durationSeconds: 60, downloadDirectory });
  context.after(async () => {
    await session.stop("test").catch(() => {});
    await fsp.rm(testRoot, { recursive: true, force: true });
  });

  assert.equal(fs.existsSync(stalePartial), false);
  assert.equal(fs.existsSync(normalFile), true);
});

test("a listen failure does not create the receive directory", async () => {
  const testRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "lan-drop-receiver-listen-"));
  const downloadDirectory = path.join(testRoot, "Downloads", "LAN Drop Receiver");

  try {
    await assert.rejects(
      createReceiverSession({
        durationSeconds: 60,
        host: "203.0.113.254",
        downloadDirectory
      })
    );
    assert.equal(fs.existsSync(downloadDirectory), false);
  } finally {
    await fsp.rm(testRoot, { recursive: true, force: true });
  }
});

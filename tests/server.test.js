"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const http = require("node:http");
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

async function sendToPhone(session, name, bytes, token = session.started.desktopToken) {
  return fetch(`http://127.0.0.1:${session.started.port}/api/outgoing`, {
    method: "POST",
    headers: { "X-Desktop-Token": token, "X-File-Name": encodeURIComponent(name) },
    body: bytes
  });
}

test("desktop files reach the phone intact without exposing local files or desktop credentials", async (context) => {
  const received = [];
  const { session, downloadDirectory, testRoot } = await createTestReceiver(context, {
    onItem: (item) => received.push(item)
  });
  const { baseUrl, token } = getSessionAccess(session);
  const bytes = Buffer.from([0, 1, 2, 127, 128, 255]);
  const name = `报告-${path.basename(testRoot)}.bin`;
  const response = await sendToPhone(session, name, bytes);
  assert.equal(response.status, 200);
  const { item } = await response.json();
  assert.deepEqual(Object.keys(item).sort(), ["id", "name", "size"]);
  assert.equal(received.length, 0);
  assert.deepEqual(await fsp.readdir(downloadDirectory), []);

  const headers = { "X-Session-Token": token };
  const listed = await fetch(`${baseUrl}/api/outgoing`, { headers });
  assert.deepEqual((await listed.json()).items, [item]);
  const desktopList = await fetch(`${baseUrl}/api/outgoing`, {
    headers: { "X-Desktop-Token": session.started.desktopToken }
  });
  assert.deepEqual((await desktopList.json()).items, [item]);
  const url = `${baseUrl}/api/outgoing/${item.id}?key=${token}`;
  const download = await fetch(url);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /^attachment;/);
  assert.ok(download.headers.get("content-disposition").includes(encodeURIComponent(name)));
  assert.equal(download.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);

  // Received files remain private to the computer and clearing receive history does not revoke outgoing files.
  const incoming = await uploadFile(baseUrl, token, "private.txt", Buffer.from("private"));
  const incomingItem = (await incoming.json()).item;
  assert.equal((await fetch(`${baseUrl}/api/outgoing/${incomingItem.id}?key=${token}`)).status, 404);
  await session.clearItems();
  assert.equal((await fetch(url)).status, 200);

  const dirs = (await fsp.readdir(os.tmpdir())).filter((entry) => entry.startsWith("lan-drop-outgoing-"));
  const temporary = dirs.map((entry) => path.join(os.tmpdir(), entry)).find((dir) => fs.existsSync(path.join(dir, name)));
  assert.ok(temporary, "outgoing copy should be in a session temporary directory");
  await session.stop("test");
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(fs.existsSync(incomingItem.savedPath), true);
});

test("outgoing APIs reject missing, wrong, and mobile-only upload credentials", async (context) => {
  const { session } = await createTestReceiver(context);
  const { baseUrl, token } = getSessionAccess(session);
  assert.equal((await fetch(`${baseUrl}/api/outgoing`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/config`)).status, 401);
  for (const candidate of ["", "wrong", token]) {
    assert.equal((await sendToPhone(session, "secret.txt", Buffer.from("secret"), candidate)).status, 401);
  }
  const response = await sendToPhone(session, "secret.txt", Buffer.from("secret"));
  const { item } = await response.json();
  for (const key of ["", "wrong", session.started.desktopToken]) {
    assert.equal((await fetch(`${baseUrl}/api/outgoing/${item.id}?key=${key}`)).status, 401);
  }
  assert.equal((await fetch(`${baseUrl}/api/outgoing/missing?key=${token}`)).status, 404);
  const config = await fetch(`${baseUrl}/api/config`, { headers: { "X-Session-Token": token } });
  const data = await config.json();
  assert.equal(data.expiresAt, session.started.expiresAt);
  assert.equal(JSON.stringify(data).includes(session.started.desktopToken), false);
});

test("outgoing uploads enforce single-file and shared session limits", async (context) => {
  const { session } = await createTestReceiver(context, {
    limits: { maxFileBytes: 1024, maxSessionBytes: 2048 }
  });
  const { baseUrl, token } = getSessionAccess(session);
  assert.equal((await sendToPhone(session, "large", Buffer.alloc(1025))).status, 413);
  assert.equal((await sendToPhone(session, "empty", Buffer.alloc(0))).status, 400);
  assert.equal((await sendToPhone(session, "one", Buffer.alloc(1024))).status, 200);
  assert.equal((await uploadFile(baseUrl, token, "two", Buffer.alloc(1024))).status, 200);
  assert.equal((await sendToPhone(session, "three", Buffer.alloc(1))).status, 413);
});

test("outgoing names are sanitized and duplicate names keep both files", async (context) => {
  const { session } = await createTestReceiver(context);
  const { baseUrl, token } = getSessionAccess(session);
  const first = await (await sendToPhone(session, "../../报告.txt", Buffer.from("first"))).json();
  const second = await (await sendToPhone(session, "../../报告.txt", Buffer.from("second"))).json();
  assert.equal(first.item.name, "报告.txt");
  assert.equal(second.item.name, "报告 (1).txt");
  assert.equal(await (await fetch(`${baseUrl}/api/outgoing/${first.item.id}?key=${token}`)).text(), "first");
  assert.equal(await (await fetch(`${baseUrl}/api/outgoing/${second.item.id}?key=${token}`)).text(), "second");
});

test("stopping during an outgoing upload cleans partial files and terminates promptly", async (context) => {
  const { session } = await createTestReceiver(context);
  const { baseUrl } = getSessionAccess(session);
  const request = http.request(`${baseUrl}/api/outgoing`, {
    method: "POST", headers: {
      "X-Desktop-Token": session.started.desktopToken,
      "X-File-Name": "interrupted.bin",
      "Content-Length": "1024"
    }
  });
  request.on("error", () => {});
  context.after(() => request.destroy());
  request.write(Buffer.alloc(100));
  // Wait for the actual partial to exist before stopping the server mid-request.
  let partialDirectory;
  for (let attempt = 0; attempt < 100 && !partialDirectory; attempt += 1) {
    for (const entry of await fsp.readdir(os.tmpdir())) {
      if (!entry.startsWith("lan-drop-outgoing-")) continue;
      const dir = path.join(os.tmpdir(), entry);
      if ((await fsp.readdir(dir)).some((file) => file.endsWith(".part"))) partialDirectory = dir;
    }
    if (!partialDirectory) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(partialDirectory);
  await session.stop("test");
  assert.equal(fs.existsSync(partialDirectory), false);
});

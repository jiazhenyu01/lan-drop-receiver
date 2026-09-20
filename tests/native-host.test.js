"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

class NativeClient {
  constructor(child) {
    this.child = child;
    this.buffer = Buffer.alloc(0);
    this.messages = [];
    this.waiters = [];

    child.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parse();
    });
  }

  parse() {
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + length) {
        return;
      }
      const message = JSON.parse(this.buffer.subarray(4, 4 + length).toString("utf8"));
      this.buffer = this.buffer.subarray(4 + length);

      const waiterIndex = this.waiters.findIndex((waiter) => waiter.type === message.type);
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    }
  }

  send(message) {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    this.child.stdin.write(Buffer.concat([header, body]));
  }

  waitFor(type, timeoutMs = 5000) {
    const existingIndex = this.messages.findIndex((message) => message.type === type);
    if (existingIndex >= 0) {
      return Promise.resolve(this.messages.splice(existingIndex, 1)[0]);
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        type,
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
          reject(new Error(`Timed out waiting for native message: ${type}`));
        }, timeoutMs)
      };
      this.waiters.push(waiter);
    });
  }
}

test("native messaging host starts, forwards text and exits after stop", async (context) => {
  const hostPath = path.resolve(__dirname, "../native-host/host.js");
  const testRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "lan-drop-native-test-"));
  const downloadDirectory = path.join(testRoot, "Downloads", "LAN Drop Receiver");
  const child = spawn(process.execPath, [hostPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      LAN_DROP_DOWNLOAD_DIR: downloadDirectory
    }
  });
  const client = new NativeClient(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  context.after(async () => {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
    await fsp.rm(testRoot, { recursive: true, force: true });
  });

  client.send({
    type: "start",
    durationSeconds: 60,
    limits: {
      maxTextBytes: 64 * 1024,
      maxFileBytes: 1024 * 1024,
      maxSessionBytes: 2 * 1024 * 1024
    }
  });

  const started = await client.waitFor("started");
  assert.ok(started.port > 0);
  assert.ok(started.mobileUrls.length > 0);
  assert.equal(started.downloadDirectory, downloadDirectory);
  const entry = new URL(started.mobileUrls[0].url);
  const token = new URLSearchParams(entry.hash.slice(1)).get("token");

  const response = await fetch(`http://127.0.0.1:${started.port}/api/text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": token
    },
    body: JSON.stringify({ text: "native bridge test" })
  });
  assert.equal(response.status, 200);

  const received = await client.waitFor("item_received");
  assert.equal(received.item.kind, "text");
  assert.equal(received.item.text, "native bridge test");

  const outgoing = await fetch(`http://127.0.0.1:${started.port}/api/outgoing`, {
    method: "POST",
    headers: { "X-Desktop-Token": started.desktopToken, "X-File-Name": "desktop.txt" },
    body: "native desktop transfer"
  });
  assert.equal(outgoing.status, 200);
  const { item } = await outgoing.json();
  const download = await fetch(`http://127.0.0.1:${started.port}/api/outgoing/${item.id}?key=${token}`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "native desktop transfer");

  client.send({ type: "stop" });
  const stopped = await client.waitFor("stopped");
  assert.equal(stopped.reason, "manual");

  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(exitCode, 0, stderr);
  assert.equal(stderr, "");
});

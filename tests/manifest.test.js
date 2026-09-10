"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "extension/manifest.json"), "utf8")
);

function extensionIdFromKey(key) {
  const digest = crypto
    .createHash("sha256")
    .update(Buffer.from(key, "base64"))
    .digest("hex")
    .slice(0, 32);
  return Array.from(digest, (character) =>
    String.fromCharCode(97 + Number.parseInt(character, 16))
  ).join("");
}

test("manifest keeps the native host extension id stable", () => {
  assert.equal(extensionIdFromKey(manifest.key), "dnajjjjocfgibphegclgajmdbjbdfbkf");
});

test("manifest requests only the expected capabilities", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ["nativeMessaging", "storage"]);
  assert.deepEqual([...manifest.host_permissions].sort(), [
    "http://127.0.0.1/*",
    "http://localhost/*"
  ]);
});

test("manifest declares the Wi-Fi icon at every Chrome toolbar size", () => {
  const expectedIcons = {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  };

  assert.deepEqual(manifest.action.default_icon, expectedIcons);
  assert.deepEqual(manifest.icons, expectedIcons);

  Object.values(expectedIcons).forEach((iconPath) => {
    assert.equal(
      fs.existsSync(path.join(projectRoot, "extension", iconPath)),
      true,
      `${iconPath} should exist`
    );
  });
});

test("extension source does not persist received content in storage.local", () => {
  const sourceFiles = ["background.js", "popup.js", "receiver.js"];
  sourceFiles.forEach((fileName) => {
    const source = fs.readFileSync(path.join(projectRoot, "extension", fileName), "utf8");
    assert.doesNotMatch(source, /storage\.local/);
  });
});

test("receiver page renders the active mobile URL as a QR code", () => {
  const html = fs.readFileSync(
    path.join(projectRoot, "extension/receiver.html"),
    "utf8"
  );
  const source = fs.readFileSync(
    path.join(projectRoot, "extension/receiver.js"),
    "utf8"
  );
  const styles = fs.readFileSync(
    path.join(projectRoot, "extension/receiver.css"),
    "utf8"
  );

  assert.match(html, /id="receiverQrCanvas"/);
  assert.ok(html.indexOf('class="session-block"') < html.indexOf('id="accessPanel"'));
  assert.ok(html.indexOf('id="accessPanel"') < html.indexOf("</header>"));
  assert.ok(html.indexOf("vendor/qrcode.js") < html.indexOf("receiver.js"));
  assert.match(source, /drawQrCode\(primaryAddress\.url\)/);
  assert.match(source, /state\.downloadDirectory/);
  assert.match(styles, /\.session-block[\s\S]*?grid-template-columns: minmax\(150px, 220px\) minmax\(0, 1fr\);/);
  assert.match(styles, /\.access-panel[\s\S]*?border-left: 1px solid var\(--line\);/);
  assert.match(styles, /\.access-qr-frame[\s\S]*?width: 112px;[\s\S]*?height: 112px;/);
});

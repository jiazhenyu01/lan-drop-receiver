# 代码与落盘清单

本文档列出“局域网投送站”创建、安装和运行时会使用的全部位置。

## 项目源码

项目自身只包含以下目录：

```text
lan-drop-receiver/
├── extension/       Chrome Manifest V3 扩展
├── native-host/     Node.js Native Messaging Host
├── installer/       安装和卸载脚本
├── tests/           自动化测试
├── CODE_INVENTORY.md
├── README.md
└── package.json
```

### `extension/`

- `manifest.json`：扩展权限、固定扩展 ID 和后台入口。
- `background.js`：开关、Native Messaging 连接和当前会话状态。
- `popup.html`、`popup.css`、`popup.js`：工具栏弹窗、地址、二维码和倒计时。
- `receiver.html`、`receiver.css`、`receiver.js`：Mac 接收页面、手机访问地址和二维码。
- `send-panel.js`：电脑发送文件到手机的独立组件，包含多选、进度和本次发送列表。
- `vendor/qrcode.js`：MIT 许可的离线二维码生成库。

### `native-host/`

- `host.js`：Chrome Native Messaging 的标准输入/输出协议。
- `server.js`：按需 HTTP Server、鉴权、限流、双向上传、手机下载和接收文件管理。
- `public/index.html`、`public/styles.css`、`public/app.js`：手机互传页面。

### `installer/`

- `install.sh`：安装 Native Host，并生成安装回执。
- `uninstall.sh`：清除 Native Host、注册文件和未完成分片；可选择删除用户文件及源码。
- `audit.sh`：只读检查所有已知落盘位置、未完成分片和运行进程。

## 执行安装后新增的位置

安装脚本只会写入以下两个固定位置：

```text
~/Library/Application Support/LAN Drop Receiver/
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.codex.lan_drop_receiver.json
```

第一个目录包含 Native Host 的安装副本、启动脚本和 `install-receipt.json`。
第二个文件告诉 Chrome 如何按需启动 Native Host。

安装脚本不会预先创建接收文件目录。首次成功启动接收服务时才会创建：

```text
~/Documents/局域网互传/
```

安装过程不会创建：

- LaunchAgent
- 登录项
- 定时任务
- 系统服务
- 数据库
- 剪贴板历史
- 云端账号或云端数据

## 接收文件与运行时数据

只有打开插件的接收开关后，Native Host 才会启动。每次会话会创建：

```text
临时 HTTP 监听端口和随机会话密钥
系统临时目录下的 lan-drop-outgoing-XXXXXX/（电脑发往手机的副本）
```

电脑发出的副本在会话正常关闭、超时或浏览器断开时删除，不修改电脑原文件。进程被强制终止时可能留下临时副本，路径为 `os.tmpdir()/lan-drop-outgoing-XXXXXX/`，由系统临时目录清理策略管理。

手机发送的文本只存在于扩展的 `chrome.storage.session` 内存状态中。手机发送的图片和文件直接写入：

```text
~/Documents/局域网互传/
```

上传未完成时，同一目录内会短暂存在严格命名的隐藏分片：

```text
.lan-drop-UUID.part
```

上传成功后，分片会原子发布为原文件名；如已有同名文件，则自动使用 `文件名 (1).扩展名`，绝不覆盖已有文件。

以下操作不删除手机已发送到电脑的完整文件（关闭会话时会删除电脑发出的临时副本）：

- 手动关闭接收开关。
- 十分钟倒计时结束。
- Chrome 关闭或 Native Messaging 连接断开。
- 接收页的“移除记录”或“清空当前内容”。
- 默认运行卸载脚本。

已保存的完整文件属于用户数据，只有显式执行 `uninstall.sh --purge-downloads` 才会删除整个接收目录。

旧版本使用的 `~/Downloads/LAN Drop Receiver/` 不会在升级时自动迁移或删除；审计和显式的 `--purge-downloads` 卸载仍会识别该目录。

## Chrome 自身保存的内容

扩展只使用 `chrome.storage.session`，不使用 `chrome.storage.local`、IndexedDB、Cookie 或网站本地存储保存接收历史。

Chrome 扩展的安装记录由 Chrome 管理。请先在 `chrome://extensions` 中点击“移除”，让 Chrome 清除扩展自身状态；卸载脚本不会直接修改 Chrome Profile 中的内部数据库。

## 完整卸载

先在 Chrome 中移除扩展，然后执行：

```bash
./installer/uninstall.sh
```

连当前项目源码一起删除：

```bash
./installer/uninstall.sh --purge-source
```

连已接收的图片和文件一起删除：

```bash
./installer/uninstall.sh --purge-downloads
```

删除安装副本、注册、接收文件和项目源码：

```bash
./installer/uninstall.sh --purge-downloads --purge-source
```

脚本执行前会打印所有删除目标并要求确认。自动化调用可以显式增加 `--yes`。

卸载前后都可以运行只读审计：

```bash
./installer/audit.sh
```

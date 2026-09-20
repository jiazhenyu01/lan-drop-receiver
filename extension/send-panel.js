"use strict";

// Keep file data in the page and stream it to localhost; Native Messaging carries only credentials.
class SendPanel extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <section class="send-panel">
        <header><div><span class="rail-label">PC → PHONE</span><h2>发送文件到手机</h2></div>
          <button type="button" disabled>选择文件并发送</button></header>
        <input type="file" multiple hidden />
        <p>手机扫码后，在“接收电脑文件”中下载。文件仅在当前会话内可用。</p>
        <p class="send-status" role="status" aria-live="polite">请先开启接收窗口</p>
        <ul></ul>
      </section>`;
    this.button = this.querySelector("button");
    this.input = this.querySelector("input");
    this.status = this.querySelector(".send-status");
    this.list = this.querySelector("ul");
    this.button.addEventListener("click", () => this.input.click());
    this.input.addEventListener("change", () => this.sendFiles());
  }

  setSession(state) {
    const token = state.status === "running" ? state.desktopToken : "";
    if (token === this.session?.token && state.status === this.session?.status) return;
    this.request?.abort();
    this.session = { token, status: state.status, base: `http://127.0.0.1:${state.port}`, limits: state.limits };
    this.busy = false;
    this.button.disabled = !token;
    this.list.replaceChildren();
    this.status.textContent = token
      ? `单个文件上限 ${Math.round(state.limits.maxFileBytes / 1024 / 1024)} MB，选择后即可发送`
      : state.status === "running" ? "请更新本地辅助程序后重新开启接收窗口" : "请先开启接收窗口";
    if (token) this.loadFiles(this.session);
  }

  async loadFiles(session) {
    try {
      const response = await fetch(`${session.base}/api/outgoing`, {
        headers: { "X-Desktop-Token": session.token }, cache: "no-store"
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "无法读取发送记录");
      if (session !== this.session) return;
      this.list.replaceChildren();
      for (const item of data.items) {
        const row = document.createElement("li");
        row.textContent = `${item.name} · ${(item.size / 1024).toFixed(1)} KB · 可在手机下载`;
        this.list.append(row);
      }
    } catch (error) {
      if (session === this.session) this.status.textContent = error.message;
    }
  }

  upload(file, session, index, total) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      this.request = request;
      request.open("POST", `${session.base}/api/outgoing`);
      request.setRequestHeader("X-Desktop-Token", session.token);
      request.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
      request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      request.timeout = 15 * 60 * 1000;
      request.upload.addEventListener("progress", (event) => {
        if (session === this.session && event.lengthComputable) {
          this.status.textContent = `正在准备 ${index + 1}/${total}：${file.name} · ${Math.round(event.loaded / event.total * 100)}%`;
        }
      });
      request.addEventListener("load", () => {
        let data = {};
        try { data = JSON.parse(request.responseText); } catch (_) { /* Report the HTTP error below. */ }
        if (request.status === 200 && data.ok) resolve();
        else reject(new Error(data.message || `发送失败（${request.status}）`));
      });
      request.addEventListener("error", () => reject(new Error("连接中断，请确认传输窗口仍已开启")));
      request.addEventListener("abort", () => reject(new Error("发送已取消")));
      request.addEventListener("timeout", () => reject(new Error("发送超时，请重试")));
      request.send(file);
    });
  }

  async sendFiles() {
    // Upload sequentially and ignore stale callbacks after the active session changes.
    const session = this.session;
    if (!session?.token || this.busy) return;
    const files = Array.from(this.input.files);
    this.input.value = "";
    if (!files.length) return;
    if (files.some((file) => !file.size || file.size > session.limits.maxFileBytes)) {
      this.status.textContent = "文件不能为空，且不能超过单个文件大小上限";
      return;
    }
    if (files.reduce((sum, file) => sum + file.size, 0) > session.limits.maxSessionBytes) {
      this.status.textContent = "所选文件总大小超过本次会话上限";
      return;
    }
    this.busy = true;
    this.button.disabled = true;
    let completed = 0;
    try {
      for (let index = 0; index < files.length; index += 1) {
        if (session !== this.session) return;
        this.status.textContent = `正在准备：${files[index].name}`;
        await this.upload(files[index], session, index, files.length);
        completed += 1;
      }
      if (session === this.session) this.status.textContent = `${completed} 个文件已就绪，请在手机上点击下载`;
    } catch (error) {
      if (session === this.session) this.status.textContent = `已准备 ${completed}/${files.length} 个文件；${error.message}。未完成的文件可重新选择发送。`;
    } finally {
      if (session === this.session) {
        this.request = null;
        this.busy = false;
        this.button.disabled = !session.token;
        await this.loadFiles(session);
      }
    }
  }
}

customElements.define("send-panel", SendPanel);

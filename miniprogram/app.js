const config = require("./config");
const devMode = config.devMode === true;
const apiBase = devMode && config.devApiBase ? config.devApiBase : config.apiBase;

/**
 * 生产只允许 HTTPS 域名；HTTP 仅在 devMode 下放行（微信开发者工具调试用）。
 * 占位域名与 Cloudflare 演示域名任何时候都拒绝，避免误连非正式环境。
 */
function blockedOrigin(base) {
  if (/production\.example\.com/.test(base)) return true;
  if (/^https:\/\/erp\.aibuild\.work(?:\/|$)/i.test(base)) return true;
  if (/^https:\/\//.test(base)) return false;
  return !devMode;
}

App({
  globalData: { apiBase, token: "", user: null, perms: [] },
  onLaunch() {
    this.globalData.token = wx.getStorageSync("erp_mini_token") || "";
  },
  setSession(data) {
    this.globalData.token = data.accessToken;
    this.globalData.user = data.user;
    this.globalData.perms = data.perms || [];
    wx.setStorageSync("erp_mini_token", data.accessToken);
  },
  clearSession() {
    this.globalData.token = "";
    this.globalData.user = null;
    this.globalData.perms = [];
    wx.removeStorageSync("erp_mini_token");
  },
  api(path, method = "GET", data = null, extraHeaders = {}) {
    if (blockedOrigin(this.globalData.apiBase)) {
      return Promise.reject(new Error(devMode
        ? "请先配置小程序接口地址"
        : "请先配置阿里云 HTTPS 正式 API 域名"));
    }
    const token = this.globalData.token;
    const headers = { "Content-Type": "application/json", ...extraHeaders };
    // Public invitation links must not transmit employee access tokens.
    if (token && !path.startsWith("/public/") && !path.startsWith("/mini/auth/login") &&
        !path.startsWith("/mini/auth/bind") && !path.startsWith("/mini/auth/phone-bind") && !path.startsWith("/mini/auth/sms/send")) {
      headers.Authorization = "Bearer " + token;
    }
    return new Promise((resolve, reject) => wx.request({
      url: this.globalData.apiBase + path, method, data: data == null ? undefined : data,
      header: headers,
      success: r => {
        if (r.statusCode >= 200 && r.statusCode < 300) return resolve(r.data);
        const error = new Error(r.data?.error?.message || "请求失败（" + r.statusCode + "）");
        error.code = r.data?.error?.code || "";
        error.status = r.statusCode;
        // Never reuse a revoked token; do not erase a newer concurrent login.
        if (r.statusCode === 401 && token && token === this.globalData.token &&
            !path.startsWith("/public/")) this.clearSession();
        reject(error);
      },
      fail: () => reject(new Error("网络异常，请检查服务器及微信合法域名配置"))
    }));
  },
  // Originals are private; opening them must carry the same session token as API reads.
  // Do not use wx.openDocument with an unauthenticated public link.
  openOriginal(fileKey) {
    if (!/^[a-f0-9]{32}\.(?:jpg|jpeg|png|webp|gif|pdf|ppt|pptx|doc|docx|xls|xlsx|csv|txt)$/i.test(String(fileKey || "")))
      return Promise.reject(new Error("无效的材料文件标识"));
    const base = this.globalData.apiBase;
    const token = this.globalData.token;
    if (blockedOrigin(base) || !token)
      return Promise.reject(new Error(devMode
        ? "请先登录测试服务"
        : "请先登录已配置的正式 HTTPS 服务"));
    return new Promise((resolve, reject) => wx.downloadFile({
      url: base + "/uploads/" + encodeURIComponent(fileKey),
      header: { Authorization: "Bearer " + token },
      success: r => {
        if (r.statusCode !== 200 || !r.tempFilePath) {
          if (r.statusCode === 401 && this.globalData.token === token) this.clearSession();
          return reject(new Error("材料原件下载失败（" + r.statusCode + "）"));
        }
        wx.openDocument({
          filePath: r.tempFilePath, showMenu: true,
          success: () => resolve(true),
          fail: () => reject(new Error("当前文件格式无法直接预览，请在网页端下载查看"))
        });
      },
      fail: () => reject(new Error("原件下载失败，请检查网络或稍后重试"))
    }));
  },
  request(path, method = "GET", data = null) { return this.api(path, method, data); },
  wechatCode() {
    return new Promise((resolve, reject) => wx.login({
      success: r => r.code ? resolve(r.code) : reject(new Error("无法获取微信登录凭证")),
      fail: () => reject(new Error("微信登录失败"))
    }));
  },
  async resume() {
    if (this.globalData.token) {
      try {
        const me = await this.api("/mini/auth/me");
        this.globalData.user = me.user;
        this.globalData.perms = me.perms || [];
        return me;
      } catch (e) {
        if (e.status !== 401) throw e;
        this.clearSession();
      }
    }
    try {
      const code = await this.wechatCode();
      const result = await this.api("/mini/auth/login", "POST", { code });
      this.setSession(result);
      return result;
    } catch (e) {
      if (e.code === "WECHAT_UNBOUND") {
        wx.reLaunch({ url: "/pages/bind/index" });
        return null;
      }
      throw e;
    }
  }
});

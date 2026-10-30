const config = require("./config");
App({
  globalData: { apiBase: config.apiBase, token: "", user: null, perms: [] },
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
    if (!/^https:\/\//.test(this.globalData.apiBase) ||
        /production\.example\.com/.test(this.globalData.apiBase)) {
      return Promise.reject(new Error("请先配置阿里云 HTTPS 正式 API 域名"));
    }
    const token = this.globalData.token;
    const headers = { "Content-Type": "application/json", ...extraHeaders };
    if (token) headers.Authorization = "Bearer " + token;
    return new Promise((resolve, reject) => wx.request({
      url: this.globalData.apiBase + path, method, data: data == null ? undefined : data,
      header: headers,
      success: r => {
        if (r.statusCode >= 200 && r.statusCode < 300) return resolve(r.data);
        const error = new Error(r.data?.error?.message || "请求失败（" + r.statusCode + "）");
        error.code = r.data?.error?.code || "";
        error.status = r.statusCode;
        reject(error);
      },
      fail: () => reject(new Error("网络异常，请检查服务器及微信合法域名配置"))
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

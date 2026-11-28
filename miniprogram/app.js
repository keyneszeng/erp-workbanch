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
  // 固定按北京时间显示系统时间；不受手机所在时区影响。
  formatDateTime(value, fallback = "—") {
    if (value == null || value === "") return fallback;
    const raw = String(value).trim();
    if (/^\\d{4}-\\d{2}-\\d{2}$/.test(raw)) return raw;
    const local = raw.match(/^(\\d{4}-\\d{2}-\\d{2})[ T](\\d{2}):(\\d{2})(?::(\\d{2}))?(?:\\.\\d+)?$/);
    if (local) return local[1] + " " + local[2] + ":" + local[3];
    const ms = typeof value === "number" ? value : Date.parse(raw);
    if (!Number.isFinite(ms)) return raw;
    const d = new Date(ms + 8 * 60 * 60 * 1000);
    const pad = n => String(n).padStart(2, "0");
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) +
      " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
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
      fail: () => reject(new Error("网络异常，请检查网络连接或联系系统管理员"))
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
        // 图片不能依赖 openDocument；使用微信原生图片预览，其余文档走原有预览能力。
        const ext = String(fileKey).split(".").pop().toLowerCase();
        if (["jpg","jpeg","png","webp","gif"].includes(ext)) {
          wx.previewImage({
            current: r.tempFilePath, urls: [r.tempFilePath],
            success: () => resolve(true),
            fail: () => reject(new Error("图片预览失败，请在网页端下载查看"))
          });
          return;
        }
        wx.openDocument({
          filePath: r.tempFilePath, showMenu: true,
          ...(["pdf","doc","docx","xls","xlsx","ppt","pptx"].includes(ext)?{fileType:ext}:{}),
          success: () => resolve(true),
          fail: () => reject(new Error("当前文件格式无法直接预览，请在网页端下载查看"))
        });
      },
      fail: () => reject(new Error("原件下载失败，请检查网络或稍后重试"))
    }));
  },
  // 仅允许生成当前会议的 PDF/PPTX 卷宗或原始 ZIP，沿用 Bearer 会话和服务端归档下载权限。
  openArchiveExport(pid,format,body) {
    const base=this.globalData.apiBase,token=this.globalData.token;
    if(blockedOrigin(base)||!token)return Promise.reject(new Error("请先登录正式服务"));
    if(!pid||!["pdf","pptx","zip"].includes(format))return Promise.reject(new Error("无效的导出参数"));
    const url=base+"/projects/"+encodeURIComponent(pid)+"/archive-"+format;
    return new Promise((resolve,reject)=>wx.request({
      url,method:"POST",data:body,responseType:"arraybuffer",timeout:120000,
      header:{"Content-Type":"application/json",Authorization:"Bearer "+token},
      success:r=>{
        if(r.statusCode!==200||!r.data?.byteLength){
          if(r.statusCode===401&&this.globalData.token===token)this.clearSession();
          return reject(new Error("卷宗生成失败（"+r.statusCode+"），请核对下载权限或改用网页端"));
        }
        const headers=r.header||{},type=String(headers["Content-Type"]||headers["content-type"]||"");
        if(format==="pdf"&&!type.includes("application/pdf")||format==="pptx"&&!type.includes("presentationml.presentation")||format==="zip"&&!type.includes("application/zip"))
          return reject(new Error("服务器未返回有效卷宗文件"));
        const fs=wx.getFileSystemManager(),safePid=String(pid).replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,80);
        const filePath=wx.env.USER_DATA_PATH+(format==="zip"?"/原始文件包-":"/会议卷宗-")+safePid+"-"+Date.now()+"."+format;
        if(this._lastArchiveExport)fs.unlink({filePath:this._lastArchiveExport,fail:()=>{}});
        fs.writeFile({filePath,data:r.data,success:()=>{
          this._lastArchiveExport=filePath;
          if(format==="zip"){
            // ZIP is not a supported wx.openDocument format. Share the saved file
            // through WeChat's native file UI; never upload it to a third party.
            if(typeof wx.shareFileMessage!=="function")return reject(new Error("ZIP 已生成，当前微信版本不支持转发文件，请在 Web 端下载"));
            wx.shareFileMessage({filePath,fileName:"会议原始文件包-"+safePid+".zip",
              success:()=>resolve(true),fail:()=>reject(new Error("原始文件包已生成，未完成转发；可重试或在 Web 端下载"))});
            return;
          }
          wx.openDocument({filePath,fileType:format,showMenu:true,success:()=>resolve(true),fail:()=>reject(new Error("卷宗已生成，但当前设备不支持预览，请在网页端下载"))});
        },fail:()=>reject(new Error("卷宗保存失败，请检查设备剩余空间或改用网页端"))});
      },fail:()=>reject(new Error("卷宗生成请求失败，较大文件请在网页端导出"))
    }));
  },
  request(path, method = "GET", data = null) { return this.api(path, method, data); },
  wechatCode() {
    return new Promise((resolve, reject) => wx.login({
      success: r => r.code ? resolve(r.code) : reject(new Error("无法获取登录凭证")),
      fail: () => reject(new Error("快捷登录失败，请重试"))
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

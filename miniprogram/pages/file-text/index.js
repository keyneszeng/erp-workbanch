// 文本类原件（txt/csv）的原生预览页。
// 微信 wx.openDocument 不支持 txt/csv，改用后端 /api/uploads/<key>?preview=1
// 返回的纯文本内联内容，走与原件下载相同的鉴权通道。
const app = getApp();

Page({
  data: { name: "文本原件", text: "", loading: true, error: "" },

  onLoad(query) {
    const key = String(query.key || "");
    const name = String(query.name || "文本原件");
    this.setData({ name });
    if (!/^[a-f0-9]{32}\.(?:txt|csv)$/i.test(key)) {
      this.setData({ loading: false, error: "无效的文本文件标识" });
      return;
    }
    app.api("/uploads/" + encodeURIComponent(key) + "?preview=1")
      .then(text => {
        const value = typeof text === "string" ? text : (text && text.text) || "";
        this.setData({ text: value.slice(0, 500000), loading: false });
      })
      .catch(err => this.setData({ loading: false, error: err.message || "文本读取失败" }));
  },

  copyText() {
    if (!this.data.text) return;
    wx.setClipboardData({ data: this.data.text });
  }
});

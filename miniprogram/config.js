// Public client configuration. Never put WeChat AppSecret or SMS secrets here.
//
// 生产：必须是已备案的 HTTPS 域名 + /api。yzjplan.com 在备案通过前，
// 阿里云会把公网 80/443 拦成 403（响应头 Server: Beaver），此时小程序
// 与证书签发都无法使用；备案生效后无需改代码，直接发布即可。
//
// 开发：devMode=true 时改用 devApiBase（http + IP），仅用于微信开发者工具
// 勾选「不校验合法域名」后的模拟器/真机调试。上传体验版或提交审核前
// 必须改回 false，否则生产包会指向测试服务器。
module.exports = {
  apiBase: "https://yzjplan.com/api",
  devMode: false,
  devApiBase: "http://8.134.140.186:8080/api"
};

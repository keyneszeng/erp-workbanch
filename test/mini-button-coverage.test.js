"use strict";
/**
 * Mini-program UI contract audit. This is a static WXML -> Page handler check;
 * actual WeChat native rendering/clickability still requires the IDE/device.
 */
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const root=path.join(__dirname,"..","miniprogram","pages");
const event=/\b(?:bind|catch)(?:tap|change|input|longpress|confirm|submit|scrolltolower|blur|focus|load|error|touchstart|touchend|touchmove|touchcancel)\s*=\s*["']([^"']+)["']/g;
const pages=fs.readdirSync(root,{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>x.name);
test("小程序所有WXML交互按钮和输入事件都存在对应 JS 处理函数",()=>{
 let events=0,interactivePages=0;
 for(const name of pages){
  const base=path.join(root,name,"index");
  if(!fs.existsSync(base+".wxml"))continue;
  assert.ok(fs.existsSync(base+".js"),name+" 页面缺少 JS 控制器");
  const markup=fs.readFileSync(base+".wxml","utf8");
  const script=fs.readFileSync(base+".js","utf8");
  const actions=[...markup.matchAll(event)].map(x=>x[1]);
  if(actions.length)interactivePages++;
  for(const handler of actions){
   events++;
   assert.match(handler,/^[A-Za-z_$][\w$]*$/,name+" 绑定了非法动态事件处理器");
   const definition=new RegExp("\\b"+handler+"\\s*(?:\\(|:)");
   assert.match(script,definition,name+" WXML 引用 "+handler+"，但 JS 未定义此功能键回调");
  }
 }
 assert.equal(interactivePages,12,"小程序12个页面都要纳入按钮/事件巡检");
 assert.ok(events>=45,"交互事件清单异常缩减，可能有功能键丢失："+events);
 console.log("MINI_BUTTON_COVERAGE "+JSON.stringify({pages:interactivePages,events}));
});

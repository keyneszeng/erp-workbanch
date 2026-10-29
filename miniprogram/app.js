App({
  globalData:{apiBase:"https://erp.aibuild.work/api"},
  request(path, method="GET", data=null) {
    return new Promise((resolve,reject)=>wx.request({
      url:this.globalData.apiBase+path,
      method,
      data:data||undefined,
      header:{"Content-Type":"application/json"},
      success:r=>r.statusCode>=200&&r.statusCode<300?resolve(r.data):reject(new Error(r.data?.error?.message||"请求失败")),
      fail:reject
    }));
  }
});
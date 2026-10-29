const app=getApp();
Page({
  data:{token:"",loading:true,error:"",title:"会议邀请函",template:"",body:"",status:"",response:"",isFinal:false},
  onLoad(q) {
    const token=q.token||"";
    if(!/^[a-f0-9]{48,64}$/.test(token))return this.setData({loading:false,error:"邀请链接无效，请联系会务负责人"});
    this.setData({token});
    this.load();
  },
  async load() {
    try {
      const r=await app.request("/public/prep-invitation?token="+this.data.token);
      this.setData({
        loading:false,title:r.title,template:r.template,
        body:(r.paragraphs||[]).join("\n\n"),status:r.status||"",
        response:r.response||"",isFinal:!!r.response
      });
    }catch(e){this.setData({loading:false,error:e.message||"邀请已过期或失效"})}
  },
  reply(e) {
    const action=e.currentTarget.dataset.action;
    wx.showModal({
      title:"请确认",content:action==="CONFIRM"?"确认接受此次邀请？":"确认暂不接受此次邀请？",
      success:async result=>{
        if(!result.confirm)return;
        try {
          await app.request("/public/prep-invitation/respond","POST",{token:this.data.token,action});
          wx.showToast({title:"回复已记录",icon:"success"});
          this.load();
        }catch(err){wx.showToast({title:err.message||"提交失败",icon:"none"})}
      }
    });
  },
  openPdf() {
    wx.downloadFile({
      url:app.globalData.apiBase+"/public/prep-invitation-pdf?token="+this.data.token,
      success:r=>{
        if(r.statusCode!==200)return wx.showToast({title:"下载失败",icon:"none"});
        wx.openDocument({filePath:r.tempFilePath,fileType:"pdf",showMenu:true});
      },fail:()=>wx.showToast({title:"下载失败",icon:"none"})
    });
  },
  onShareAppMessage() {
    return {title:this.data.title||"会议邀请函",path:"/pages/invite/index?token="+this.data.token};
  }
});
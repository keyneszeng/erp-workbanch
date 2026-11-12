const app=getApp();
Page({
 data:{busy:false,error:"",consent:false},
 publicApply(){wx.navigateTo({url:"/pages/public-proposal/index"});},
 agree(e){this.setData({consent:(e.detail.value||[]).includes("agree")});},
 async getPhoneNumber(e){
  if(this.data.busy)return;
  if(!this.data.consent){this.setData({error:"请先同意手机号用于账号匹配与登录"});return;}
  const phoneCode=e.detail?.code;
  if(!phoneCode){this.setData({error:"未获得微信手机号授权，请点击按钮并同意授权"});return;}
  this.setData({busy:true,error:""});
  try{
   // wx.login credential (OpenID) and getPhoneNumber credential (phone) differ.
   const code=await app.wechatCode();
   const result=await app.api("/mini/auth/phone-bind","POST",{code,phoneCode});
   app.setSession(result);
   wx.showToast({title:"绑定成功",icon:"success"});
   wx.reLaunch({url:"/pages/home/index"});
  }catch(err){this.setData({error:err.message||"手机号绑定失败"});}
  finally{this.setData({busy:false});}
 }
});
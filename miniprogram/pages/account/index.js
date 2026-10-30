const app=getApp();
Page({
 data:{user:null,oldPassword:"",newPassword:"",smsCode:"",error:"",busy:false},
 onShow(){this.setData({user:app.globalData.user});},
 input(e){this.setData({[e.currentTarget.dataset.key]:e.detail.value});},
 async send(){try{await app.api("/mini/auth/sms/send-password","POST",{});wx.showToast({title:"验证码已发送",icon:"success"});}
 catch(e){this.setData({error:e.message});}},
 async change(){
  this.setData({busy:true,error:""});
  try{
   const r=await app.api("/mini/auth/password","POST",{oldPassword:this.data.oldPassword,
    newPassword:this.data.newPassword,smsCode:this.data.smsCode});
   app.setSession(r);
   wx.showToast({title:"修改成功",icon:"success"});wx.reLaunch({url:"/pages/home/index"});
  }catch(e){this.setData({error:e.message});}
  finally{this.setData({busy:false});}
 },
 async logout(){
  try{await app.api("/mini/auth/logout","POST",{});}catch(_){}
  app.clearSession();wx.reLaunch({url:"/pages/bind/index"});
 }
});
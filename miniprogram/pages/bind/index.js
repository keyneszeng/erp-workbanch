const app = getApp();
Page({
  data:{phone:"",password:"",newPassword:"",smsCode:"",error:"",busy:false},
  input(e){this.setData({[e.currentTarget.dataset.key]:e.detail.value});},
  async send(){
    this.setData({error:""});
    try {
      await app.api("/mini/auth/sms/send","POST",{phone:this.data.phone,password:this.data.password});
      wx.showToast({title:"验证码已发送",icon:"success"});
    }catch(e){this.setData({error:e.message});}
  },
  async bind(){
    if(this.data.busy)return;
    this.setData({busy:true,error:""});
    try{
      const code=await app.wechatCode();
      const result=await app.api("/mini/auth/bind","POST",{
        code,phone:this.data.phone,password:this.data.password,
        smsCode:this.data.smsCode,newPassword:this.data.newPassword
      });
      app.setSession(result);
      wx.reLaunch({url:"/pages/home/index"});
    }catch(e){this.setData({error:e.message});}
    finally{this.setData({busy:false});}
  }
});
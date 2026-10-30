const app = getApp();
Page({
 data:{user:null,role:"",loading:true,error:"",canApprove:false,canMaterials:false,dashboard:null},
 async onShow(){
   this.setData({loading:true,error:""});
   try{
     const state=await app.resume();if(!state)return;
     if(state.user?.mustChangePassword){wx.navigateTo({url:"/pages/account/index"});return;}
     const ps=app.globalData.perms||[];
     const canApprove=ps.some(p=>["project:approve","verify:exception_approve","payment:approve"].includes(p));
     const canMaterials=ps.includes("material:write");
     const dashboard=await app.api("/dashboard");
     this.setData({user:app.globalData.user,role:state.role?.name||"",dashboard,
       canApprove,canMaterials,loading:false});
   }catch(e){this.setData({error:e.message,loading:false});}
 },
 go(e){wx.navigateTo({url:"/pages/"+e.currentTarget.dataset.page+"/index"});}
});
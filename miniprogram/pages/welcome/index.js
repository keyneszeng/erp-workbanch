Page({
 goPublic(){wx.navigateTo({url:"/pages/public-proposal/index"});},
 goStaff(){wx.navigateTo({url:"/pages/home/index"});},
 onShareAppMessage(){return {title:"活动立项意向申请",path:"/pages/public-proposal/index"};}
});
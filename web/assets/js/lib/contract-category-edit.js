import {api,can} from "./api.js";
import {closeModal,esc,modal,toast} from "./ui.js";

export const CONTRACT_CATEGORY_OPTIONS=[
 {value:"会务需求",label:"会务协议"},
 {value:"劳务专家",label:"劳务协议"},
 {value:"企业赞助",label:"企业赞助合同"}
];

export function canEditContractCategory(contract,projectStatus=""){
 const phase=projectStatus||contract.pstatus||"";
 if(["已结算","已归档"].includes(phase))return false;
 if(!["草稿","待签署","已签署"].includes(contract.status))return false;
 return contract.status==="已签署"?can("contract:approve"):can("contract:write");
}

/** 台账和项目详情共用，修改类别不要求重复上传合同原件。 */
export function openContractCategoryEdit(contract,onDone=()=>{}){
 const label=CONTRACT_CATEGORY_OPTIONS.find(x=>x.value===contract.category)?.label||contract.category||"未分类";
 const opts=CONTRACT_CATEGORY_OPTIONS.map(x=>
  '<option value="'+esc(x.value)+'"'+(x.value===contract.category?' selected':'')+'>'+esc(x.label)+'</option>'
 ).join("");
 const m=modal({
  title:"修改合同 · "+esc(contract.id),
  width:"620px",
  body:'<div class="hint" style="margin-bottom:12px">合同：<b>'+esc(contract.name)+'</b> · 当前类别：'+esc(label)+'</div>'+
    '<div class="fld"><label>合同类别 <span class="req">*</span></label>'+
      '<select name="category" aria-label="修改合同类别">'+opts+'</select>'+
      '<div class="tip">会务协议关联第6项核销；劳务协议关联第5项；企业赞助合同进入会议收入及第7项权益核对。</div></div>'+
    '<div class="gate" style="margin-top:12px"><b>类别修改规则：</b>合同类别变更后保留合同编号与原件，签署状态退回草稿，须重新提交签署和审批。原核销中与该类别相关的步骤需重新核验；项目已核销时将退回待核销。已结算、已归档或已有付款的项目不可直接修改；企业赞助合同如已有回款、发票或确认的权益须先处理清算。</div>',
  footer:'<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">保存合同类别</button>'
 });
 m.querySelector('[data-x="0"]').onclick=()=>closeModal();
 const btn=m.querySelector('[data-x="1"]');
 btn.onclick=async()=>{
  const category=m.querySelector('[name="category"]').value;
  if(category===contract.category){closeModal();return;}
  btn.disabled=true;btn.textContent="保存中…";
  try{
   const r=await api.patch("/api/contracts/"+encodeURIComponent(contract.id)+"/category",{
    category,expected_category:contract.category,expected_status:contract.status
   });
   toast(r.message,"ok");
   closeModal();
   await onDone();
  }catch(e){
   toast(e.message||"合同类别修改失败","warn");
   btn.disabled=false;btn.textContent="保存合同类别";
  }
 };
}

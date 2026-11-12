import {api} from "./api.js";
import {esc,modal,toast} from "./ui.js";

/** Confirm extracted sponsor benefit suggestions before photo taxonomy becomes auditable. */
export function openSponsorRightsEditor(root,projects,pid,data,contractId,refresh){
  const contract=(data.contracts||[]).find(c=>c.id===contractId);
  if(!contract)return;
  const categories=(data.rights||[]).filter(r=>r.sponsor_id===contractId).map(r=>r.category);
  const html='<div class="gate">OCR 自动分类仅作建议。请打开'+
    '<a class="link" target="_blank" rel="noopener" href="/api/uploads/'+encodeURIComponent(contract.file_key)+'">赞助合同原件</a>'+
    '逐项核对，可增加、删除或修改权益名称。确认后将自动出现在材料库「权益照片」二级类目中。</div>'+
    '<div class="fld" style="margin-top:12px"><label>合同权益清单（每行一个类目）</label>'+
    '<textarea name="rightCategories" rows="9" placeholder="主会场背景板LOGO露出&#10;会议手册鸣谢">'+esc(categories.join("\n"))+'</textarea></div>'+
    '<label class="hint" style="display:block;margin-top:10px"><input type="checkbox" name="confirmEmpty"> 合同明确没有任何权益交付（仅在核对原件后勾选）</label>';
  const m=modal({title:"校正权益内容 · "+contract.enterprise,width:"670px",body:html,
    footer:'<button class="btn btn-o" data-cancel>取消</button><button class="btn btn-p" data-save>确认权益清单</button>'});
  m.querySelector("[data-cancel]").onclick=()=>m.classList.remove("open");
  m.querySelector("[data-save]").onclick=async()=>{
    const items=m.querySelector('textarea[name="rightCategories"]').value.split(/\n+/).map(s=>s.trim()).filter(Boolean);
    const btn=m.querySelector("[data-save]");btn.disabled=true;
    try{
      await api.patch("/api/projects/"+encodeURIComponent(pid)+"/income/contracts/"+encodeURIComponent(contractId)+"/rights",{
        categories:items,confirmNoRights:m.querySelector('[name="confirmEmpty"]').checked
      });
      m.classList.remove("open");toast("权益内容已确认，可在材料库关联上传权益照片","ok");
      await refresh(root,projects);
    }catch(e){toast(e.message,"warn");btn.disabled=false;}
  };
}

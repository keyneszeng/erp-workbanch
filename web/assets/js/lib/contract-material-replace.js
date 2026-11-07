import { api } from "./api.js";
import { esc, modal, toast } from "./ui.js";
import { checkFile, UPLOAD_ACCEPT, UPLOAD_TIP } from "./upload.js";

/** 合同材料仅上传一份新原件；不压缩、不修改原始合同字节。 */
export function openContractMaterialReplace(material,onDone=()=>{}) {
  if(material.kind!=="合同" || !material.file_key)return;
  const m=modal({
    title:"修改合同材料文件",
    width:"600px",
    body:`<p class="hint">材料：<b>${esc(material.name)}</b></p>
      <p class="hint">当前文件：${esc(material.file_name||material.file_key)}</p>
      <div class="fld"><label>新合同文件（替换原件，20 MB 以内）</label>
        <input type="file" name="replacement" accept="${UPLOAD_ACCEPT}">
        <div class="tip">${UPLOAD_TIP}</div>
      </div>
      <div class="gate" style="margin-top:10px">替换后旧原件不再是当前文件；如有关联合同台账，原签署状态会退回草稿，须重新提交签署与审批。已核销/结算/归档的项目不能修改。</div>
      <label style="display:block;margin-top:10px"><input type="checkbox" name="ack"> 已知悉原件替换及重审要求</label>`,
    footer:'<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">上传并替换</button>'
  });
  m.querySelector('[data-x="0"]').onclick=()=>m.classList.remove("open");
  const save=m.querySelector('[data-x="1"]');
  save.onclick=async()=>{
    const file=m.querySelector('input[name="replacement"]').files?.[0];
    if(!file){toast("请选择一个新的合同文件","warn");return;}
    const err=checkFile(file);
    if(err){toast(err,"warn");return;}
    if(!m.querySelector('input[name="ack"]').checked){
      toast("请确认替换与重新签署要求","warn");return;
    }
    save.disabled=true;save.textContent="上传中…";
    try{
      const uploaded=await api.upload(file,{pid:material.pid});
      save.textContent="正在替换…";
      const result=await api.patch("/api/materials/"+encodeURIComponent(material.id)+"/file",{
        expected_file_key:material.file_key,
        file_key:uploaded.key,file_name:uploaded.name
      });
      toast(result.message,"ok");
      if(result.warning)toast(result.warning,"warn");
      m.classList.remove("open");
      await onDone();
    }catch(e){
      save.disabled=false;save.textContent="上传并替换";
      toast(e.message,"warn");
    }
  };
}

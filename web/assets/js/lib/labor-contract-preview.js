import { esc } from "./ui.js";

// Read-only preview. The server rechecks matching against project materials on submit.
const key=x=>String(x||"").normalize("NFKC").replace(/\s+/g,"").trim();
const contractKey=x=>key(x)
  .replace(/\.(?:pdf|docx?|png|jpe?g|webp|xlsx?|pptx?)$/i,"")
  .replace(/(?:-|_|—|－)?(?:专家劳务合同|劳务服务合同|劳务合同|专家合同|讲课合同|合同)$/u,"");
const matches=(m,name)=>[m.file_name,m.name].some(v=>v&&contractKey(v)===key(name));
export function bindLaborContractPreview(m,materials){
  const input=m.querySelector('textarea[name="collectionRecords"]');
  const box=m.querySelector('[data-labor-contract-preview]');
  if(!input||!box)return;
  const contracts=materials.filter(x=>x.kind==="合同" && x.file_key && !x.deleted_at);
  const render=()=>{
    const people=[...new Set(input.value.split(/\n+/).map(x=>x.split("|")[0].trim()).filter(Boolean))];
    if(!people.length){
      box.innerHTML='<div class="hint">输入劳务表中的每个人员姓名后，自动展示同名合同匹配结果。</div>';
      return;
    }
    box.innerHTML='<h4>合同文件姓名关联预览</h4><ul class="dlist">'+people.map(person=>{
      const matchesForPerson=contracts.filter(x=>matches(x,person));
      const status=matchesForPerson.length===0?'<span class="neg">缺少同名合同</span>':
        matchesForPerson.length>1?'<span class="neg">多份同名合同，请消除歧义</span>':
        '<a class="link" target="_blank" rel="noopener" href="/api/uploads/'+encodeURIComponent(matchesForPerson[0].file_key)+'">'+
        esc(matchesForPerson[0].file_name||matchesForPerson[0].name)+' · 查看原件</a>';
      return '<li><b>'+esc(person)+'</b>：'+status+'</li>';
    }).join("")+'</ul><div class="hint">仅查找本项目材料库中的有效合同附件，正式判定由服务端重新匹配。</div>';
  };
  input.addEventListener("input",render);
  render();
}

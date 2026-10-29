"use strict";
/**
 * 会议编号（projects.id）是跨模块唯一不可变主键。
 * 注意所有金额只按「会议编号 pid」查原始表，不创建副本账。
 * 此页是读时对账视图，不更改已核销/已结算/已归档原始记录。
 */
const { db }=require("../lib/db");
const { assertCan }=require("../lib/rbac");
const { getProject }=require("../lib/workflow");
const { bad, yuan, cents }=require("../lib/util");

function requireAdmin(ctx) {
  assertCan(ctx.user,"ledger:read","项目台账仅总管理员可以查看和导出");
}
const addCents=(rows,condition=()=>true)=>rows.filter(condition).reduce((sum,row)=>sum+cents(row.amount),0);
const total=(rows,condition)=>yuan(addCents(rows,condition)/100);
const val=(n)=>yuan(Number(n)||0);
const raw=(pid)=>{
  const project=getProject(pid);
  const contracts=db.prepare(
    "SELECT id,pid,name,vendor,category,amount,status,sign_date,file_key,file_name,created_at FROM contracts WHERE pid=? ORDER BY id"
  ).all(pid);
  const payments=db.prepare(
    "SELECT id,pid,type,payee,amount,status,invoice_no,paid_at,created_at FROM payments WHERE pid=? ORDER BY created_at,id"
  ).all(pid);
  const settlement=db.prepare(
    "SELECT id,pid,income,expense,profit,status,created_at FROM settlements WHERE pid=?").get(pid)||null;
  const materials=db.prepare(
    "SELECT id,pid,kind,name,version,file_key,file_name,created_at FROM materials WHERE pid=? AND (kind LIKE '%发票%' OR kind LIKE '%付款%' OR kind LIKE '%财务%' OR kind LIKE '%结算%' OR kind LIKE '%劳务%' OR kind LIKE '%合同%') ORDER BY id"
  ).all(pid);
  const approvals=db.prepare(
    "SELECT id,pid,type,ref_id,status,amount,decided_at FROM approvals WHERE pid=? AND type='付款审批' ORDER BY id"
  ).all(pid);
  return {project,contracts,payments,settlement,materials,approvals};
}

function summarize(x){
  const {project:p,contracts, payments,settlement,materials}=x;
  const signed=total(contracts,r=>r.status==="已签署");
  const signedTotal=total(contracts);
  const paid=total(payments,r=>r.status==="已付款");
  const active=total(payments,r=>r.status!=="已驳回");
  const pending=total(payments,r=>r.status==="待审批"||r.status==="已审批");
  const payTypes=["学会公付","个人报销","厂家款"].map(type=>({
    type,count:payments.filter(r=>r.type===type).length,
    applied:total(payments,r=>r.type===type&&r.status!=="已驳回"),
    paid:total(payments,r=>r.type===type&&r.status==="已付款")
  }));
  const invoiceNumberCount=payments.filter(r=>String(r.invoice_no||"").trim()).length;
  const invoiceFileCount=materials.filter(r=>/发票/.test(r.kind)&&!!r.file_key).length;
  const paymentVoucherFiles=materials.filter(r=>/付款凭证|厂家付款凭证/.test(r.kind)&&!!r.file_key).length;
  const contractFileCount=contracts.filter(r=>!!r.file_key).length;
  const warnings=[];
  if(payments.some(r=>r.status==="待审批"||r.status==="已审批")) warnings.push("仍有待审批/待支付的付款单，未完成对账");
  if(invoiceNumberCount>0 && invoiceFileCount===0) warnings.push("存在发票号码登记，但没有关联的发票原件；仅有发票号不代表发票已归档");
  if(payments.some(r=>r.type==="厂家款")) warnings.push("现有「厂家款」属于付款类型，并不能据此判定厂家款已到账；厂家付款凭证需要独立关联");
  if(settlement && cents(settlement.expense)!==cents(paid)) warnings.push("结算单支出与已付款合计不一致，请人工核对口径与时点");
  if(contracts.some(r=>r.status==="已签署"&&!r.file_key)) warnings.push("存在已签署合同但未关联电子合同原件");
  const sums={
    budget:val(p.budget),
    contract_total:signedTotal,signed_contracts:signed,
    payment_effective:active,payment_paid:paid,payment_pending:pending,
    budget_remaining:yuan((cents(p.budget)-cents(active))/100),
    settlement_income:settlement?val(settlement.income):null,
    settlement_expense:settlement?val(settlement.expense):null,
    settlement_profit:settlement?val(settlement.profit):null,
    settlement_vs_paid:settlement?yuan((cents(settlement.expense)-cents(paid))/100):null
  };
  return {
    meeting_no:p.id,project_name:p.name,association:p.assoc,meeting_date:p.date,
    project_status:p.status,canonical_key:"projects.id",
    financial_summary:sums,payment_types:payTypes,
    document_coverage:{contracts:contracts.length,contract_original_files:contractFileCount,
      invoice_numbers:invoiceNumberCount,invoice_original_files:invoiceFileCount,
      payment_voucher_files:paymentVoucherFiles,financial_material_records:materials.length},
    warnings
  };
}
function buildDetail(pid){
  const data=raw(pid);
  return {
    ...summarize(data),
    contracts:data.contracts,
    payments:data.payments,
    settlement:data.settlement,
    financial_materials:data.materials,
    payment_approvals:data.approvals,
    notes:[
      "所有记录均通过原始业务表的 pid=会议编号关联，项目台账不复制第二套账。",
      "已签署合同、付款和结算金额口径不同，差异仅是人工核对线索，不代表必然有错。",
      "付款单发票号与材料发票附件并非一对一关联；若无逐票关联不能宣称完整核对成功。",
      "厂家款历史类型不等同于厂家付款凭证或企业真实到账证明。"
    ]
  };
}
const quote=v=>'"'+String(v==null?"":v).replace(/"/g,'""')+'"';
function csvRow(row){return row.map(quote).join(",");}
function exportCsv(detail){
  const rows=[["会议编号","资料类别","单据号","项目或对象","类型/状态","金额(元)","关联发票号","附件文件名","补充说明"]];
  const n=detail.meeting_no;
  for(const c of detail.contracts) rows.push([n,"合同",c.id,c.name+" / "+c.vendor,c.status,c.amount,"",c.file_name||"",c.category||""]);
  for(const p of detail.payments) rows.push([n,"付款",p.id,p.payee,p.type+" / "+p.status,p.amount,p.invoice_no||"","",p.paid_at||""]);
  for(const m of detail.financial_materials) rows.push([n,"财务材料",String(m.id),m.name,m.kind,"","",m.file_name||"",m.version||""]);
  if(detail.settlement){
    const s=detail.settlement;
    rows.push([n,"结算",s.id,detail.project_name,s.status,s.expense,"","","收入 "+s.income+"；利润 "+s.profit]);
  }
  rows.push([n,"对账摘要","",detail.project_name,"预算",detail.financial_summary.budget,"","",""]);
  rows.push([n,"对账摘要","",detail.project_name,"已签署合同金额",detail.financial_summary.signed_contracts,"","",""]);
  rows.push([n,"对账摘要","",detail.project_name,"已付款金额",detail.financial_summary.payment_paid,"","",""]);
  for(const w of detail.warnings) rows.push([n,"待核对","",detail.project_name,"提示","","","",w]);
  return "\ufeff"+rows.map(csvRow).join("\r\n")+"\r\n";
}
function register(router){
  router.get("/api/project-ledger",async ctx=>{
    requireAdmin(ctx);
    const keyword=String(ctx.query.q||"").trim();
    if(keyword.length>100)throw bad("筛选词不能超过100字符");
    const page=Number(ctx.query.page||1), size=Number(ctx.query.size||30);
    if(!Number.isInteger(page)||page<1||page>100000 || !Number.isInteger(size)||size<1||size>100)
      throw bad("分页参数无效");
    const all=db.prepare("SELECT id,name,assoc,status,date FROM projects ORDER BY date DESC,id DESC").all();
    const filtered=keyword?all.filter(p=>[p.id,p.name,p.assoc].some(v=>String(v||"").includes(keyword))):all;
    const rows=filtered.slice((page-1)*size,page*size).map(p=>summarize(raw(p.id)));
    return {rows,total:filtered.length,page,size,pages:Math.max(1,Math.ceil(filtered.length/size)),
      source:"projects.id / contracts.pid / payments.pid / settlements.pid / materials.pid"};
  });
  router.get("/api/project-ledger/:meetingNo",async ctx=>{
    requireAdmin(ctx);
    return buildDetail(ctx.params.meetingNo);
  });
  router.get("/api/project-ledger/:meetingNo/export",async ctx=>{
    requireAdmin(ctx);
    const detail=buildDetail(ctx.params.meetingNo);
    return {__csv:exportCsv(detail),__filename:detail.meeting_no+"-项目台账.csv"};
  });
}
module.exports={register,buildDetail,exportCsv};

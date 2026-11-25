"use strict";
/**
 * Generate a two-section Office Open XML presentation from verified project
 * finance records. PizZip is already installed for DOCX templates and works
 * on Node and Cloudflare without native fonts, spawn or a template file.
 *
 * Slide 1: name, date and association.
 * Slide 2: ONE payment reconciliation table (no payment continuation).
 * Slide 3 onwards: the exact user-sorted material collection entries.
 */
const PizZip=require("pizzip");
const {cents}=require("./util");
const W=12192000,H=6858000;
const P="http://schemas.openxmlformats.org/presentationml/2006/main";
const A="http://schemas.openxmlformats.org/drawingml/2006/main";
const R="http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG="http://schemas.openxmlformats.org/package/2006/relationships";
const CT="http://schemas.openxmlformats.org/package/2006/content-types";
const COLORS={ink:"152B47",blue:"183858",teal:"0CA5A9",paper:"F6F9FC",
 white:"FFFFFF",muted:"61748B",line:"DAE3ED",stripe:"EBF3F7",warn:"AF5E30"};
const xml=s=>String(s??"").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g," ")
 .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const cut=(s,n)=>{const v=String(s??"");return v.length>n?v.slice(0,n-1)+"…":v;};
const money=v=>"¥"+(Number.isFinite(Number(v))?Number(v):0).toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2});
const rel=(id,type,target)=>'<Relationship Id="'+id+'" Type="'+R+"/"+type+'" Target="'+target+'"/>';
const rels=inner=>'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="'+PKG+'">'+inner+'</Relationships>';
let shapeId=2;
function rect(x,y,w,h,fill=COLORS.white,line=""){
 const id=shapeId++;
 return '<p:sp><p:nvSpPr><p:cNvPr id="'+id+'" name="Box '+id+'"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'+
  '<p:spPr><a:xfrm><a:off x="'+x+'" y="'+y+'"/><a:ext cx="'+w+'" cy="'+h+'"/></a:xfrm>'+
  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="'+fill+'"/></a:solidFill>'+
  (line?'<a:ln w="6700"><a:solidFill><a:srgbClr val="'+line+'"/></a:solidFill></a:ln>':'<a:ln><a:noFill/></a:ln>')+
  '</p:spPr></p:sp>';
}
function textBox(text,x,y,w,h,size=1650,opts={}){
 const id=shapeId++;
 const color=opts.color||COLORS.ink,align=opts.align||"l",anchor=opts.anchor||"ctr";
 const font=opts.font||"Microsoft YaHei",bold=opts.bold?' b="1"':"";
 const paras=String(text??"").split("\n").slice(0,16).map(line=>
  '<a:p><a:pPr algn="'+align+'"/><a:r><a:rPr lang="zh-CN" sz="'+size+'"'+bold+' dirty="0">'+
  '<a:solidFill><a:srgbClr val="'+color+'"/></a:solidFill>'+
  '<a:latin typeface="Aptos"/><a:ea typeface="'+xml(font)+'"/></a:rPr><a:t>'+xml(line)+'</a:t>'+
  '</a:r><a:endParaRPr lang="zh-CN"/></a:p>').join("");
 return '<p:sp><p:nvSpPr><p:cNvPr id="'+id+'" name="Text '+id+'"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'+
 '<p:spPr><a:xfrm><a:off x="'+x+'" y="'+y+'"/><a:ext cx="'+w+'" cy="'+h+'"/></a:xfrm>'+
 '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>'+
 '<p:txBody><a:bodyPr wrap="square" anchor="'+anchor+'" lIns="75000" rIns="75000" tIns="30000" bIns="30000"/>'+
 '<a:lstStyle/>'+paras+'</p:txBody></p:sp>';
}
function slideXml(shapes){
 return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
  '<p:sld xmlns:a="'+A+'" xmlns:r="'+R+'" xmlns:p="'+P+'"><p:cSld><p:spTree>'+
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'+
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'+
  shapes.join("")+'</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}
function first(project){
 shapeId=2;
 const items=[rect(0,0,W,H,COLORS.ink),rect(0,0,95000,H,COLORS.teal),
  rect(670000,920000,4100000,35000,COLORS.teal),
  textBox("会 议 资 料 归 档",670000,1070000,10000000,500000,1850,{color:"A8CDD3",bold:true}),
  textBox(cut(project.name,48),670000,2000000,10700000,1450000,3300,{color:COLORS.white,bold:true}),
  rect(670000,4170000,10400000,22000,"3F6278"),
  textBox("会议时间",750000,4530000,1800000,480000,1550,{color:"9FB8C5"}),
  textBox(String(project.date||"待确定")+(Number(project.days)>1?"（"+project.days+"天）":""),2670000,4490000,8500000,520000,1800,{color:COLORS.white,bold:true}),
  textBox("主办协会",750000,5220000,1800000,480000,1550,{color:"9FB8C5"}),
  textBox(project.assoc||"—",2670000,5190000,8500000,520000,1800,{color:COLORS.white,bold:true}),
  textBox("会议编号："+String(project.id||""),670000,6300000,8000000,300000,1050,{color:"8EAFC1"})];
 return slideXml(items);
}
function normalized(s){return String(s||"").normalize("NFKC").replace(/\s+/g,"").toLowerCase();}
function buildPaymentRows(payments,contracts){
 const contractByVendor=new Map();
 for(const c of contracts||[]){
  if(c.status!=="已签署"||c.deleted_at||c.category==="企业赞助")continue;
  const key=normalized(c.vendor);
  contractByVendor.set(key,(contractByVendor.get(key)||0)+cents(c.amount));
 }
 return (payments||[]).map((p,i)=>{
  const linked=contractByVendor.get(normalized(p.payee));
  return {
   no:i+1,id:String(p.id||""),type:String(p.type||""),
   payee:String(p.payee||""),amount:Number(p.amount)||0,
   status:String(p.status||""),receipt:p.receipt_file_key?"已存档":"未附回单",
   contract:linked===undefined?null:linked/100
  };
 });
}
/** Keep the entire payment comparison as exactly one table on exactly one slide. */
function oneTableRows(rows){
 if(rows.length<=18)return {rows,note:""};
 const map=new Map();
 for(const row of rows){
  const k=row.type;
  let g=map.get(k);
  if(!g){g={...row,amount:0,contract:null,payee:"",id:"",no:0,paid:0,pending:0,receipts:0,count:0};map.set(k,g);}
  g.count++;g.amount=Math.round((g.amount+row.amount)*100)/100;
  if(row.status==="已付款")g.paid++;else g.pending++;
  if(row.receipt==="已存档")g.receipts++;
 }
 return {rows:[...map.values()].map((g,i)=>({
  ...g,no:i+1,payee:"共 "+g.count+" 笔付款",status:"已付"+g.paid+"/其他"+g.pending,
  receipt:"凭证 "+g.receipts+"/"+g.count,contract:null
 })),note:"付款单超过18笔，已在本表按类目汇总；逐笔流水请查财务台账。"};
}
function financeSlide(project,allRows,stats){
 shapeId=2;
 const {rows,note}=oneTableRows(allRows);
 const shapes=[rect(0,0,W,H,COLORS.paper),rect(0,0,W,1080000,COLORS.blue),
  rect(0,1050000,W,30000,COLORS.teal),
  textBox("付款明细对照表",520000,240000,10000000,480000,2600,{color:COLORS.white,bold:true}),
  textBox(cut(project.name,35),530000,700000,10700000,240000,1300,{color:"C7E5ED"}),
  textBox("关联合同总额："+money(stats.signed),520000,1250000,3700000,300000,1350,{color:COLORS.blue,bold:true}),
  textBox("实际已付："+money(stats.paid),4300000,1250000,3100000,300000,1350,{color:COLORS.blue,bold:true}),
  textBox("待付："+money(stats.pending),7900000,1250000,3700000,300000,1350,{color:COLORS.blue,bold:true})];
 const xs=[520000,980000,2410000,4550000,6420000,7910000,9340000,11660000];
 const cols=["序号","类目","收款方 / 付款单","关联合同额","本笔金额","付款状态","凭证"];
 const yTop=1860000,headerH=470000;
 const body=rows.length?rows:[{no:"—",type:"",payee:"本会议尚无付款记录",id:"",
  contract:null,amount:0,status:"",receipt:""}];
 const rowH=Math.min(395000,Math.floor(3570000/body.length));
 const fontSize=rowH<225000?800:rowH<300000?930:1200;
 for(let c=0;c<cols.length;c++){
  const x=xs[c],w=xs[c+1]-x;
  shapes.push(rect(x,yTop,w,headerH,COLORS.blue));
  shapes.push(textBox(cols[c],x+17000,yTop+25000,w-34000,headerH-50000,1240,{color:COLORS.white,bold:true,align:"ctr"}));
 }
 for(let i=0;i<body.length;i++){
  const row=body[i],yy=yTop+headerH+i*rowH;
  const label=rowH>=280000?cut(row.payee,15)+"\n"+cut(row.id,19):
   cut(row.payee,15)+(row.id?" / "+cut(row.id,13):"");
  const values=[String(row.no),cut(row.type,10),label,
   row.contract===null?"待关联":money(row.contract),money(row.amount),row.status,row.receipt];
  for(let c=0;c<values.length;c++){
   const x=xs[c],w=xs[c+1]-x,fill=i%2===0?COLORS.white:COLORS.stripe;
   shapes.push(rect(x,yy,w,rowH,fill,COLORS.line));
   shapes.push(textBox(values[c],x+16000,yy+10000,w-32000,rowH-20000,c===2?Math.max(750,fontSize-100):fontSize,{
    color:c===6&&row.receipt==="未附回单"?COLORS.warn:COLORS.ink,
    align:c===0||c>=3?"ctr":"l",bold:c===4
   }));
  }
 }
 const diff=Math.round((cents(stats.signed)-cents(stats.paid)))/100;
 shapes.push(textBox(note||"合同额按同名签约方匹配，多笔付款可能引用同一合同；未匹配记“待关联”。",
  520000,6070000,11000000,240000,1070,{color:COLORS.muted}));
 shapes.push(textBox("已签合同－实际已付："+money(diff)+"；只统计状态为“已付款”的实际付款。",
  520000,6350000,10800000,220000,1080,{color:COLORS.blue}));
 shapes.push(textBox("会规智云 · 付款对照 · 第 2 页",9600000,6530000,2100000,200000,850,{color:COLORS.muted,align:"r"}));
 return slideXml(shapes);
}
/** Image media is embedded into OOXML slides, not replaced by a filename. */
function imageSize(data,mime){
 const b=Buffer.from(data);
 if(mime==="image/png"&&b.length>=24)return {w:b.readUInt32BE(16),h:b.readUInt32BE(20)};
 if(mime==="image/jpeg"){
  let o=2;
  while(o+9<b.length){
   if(b[o]!==0xff){o++;continue;}
   const marker=b[o+1],len=b.readUInt16BE(o+2);
   if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb].includes(marker))
    return {w:b.readUInt16BE(o+7),h:b.readUInt16BE(o+5)};
   if(len<2)break;o+=2+len;
  }
 }
 return {w:16,h:9};
}
function imageShape(slide,relId="rId2"){
 const dim=imageSize(slide.image,slide.mime);
 const maxW=10900000,maxH=5100000;
 const scale=Math.min(maxW/dim.w,maxH/dim.h);
 const width=Math.round(dim.w*scale),height=Math.round(dim.h*scale);
 const x=Math.round((W-width)/2),y=1230000+Math.round((maxH-height)/2);
 const id=shapeId++;
 return '<p:pic><p:nvPicPr><p:cNvPr id="'+id+'" name="会议资料原件图片" descr="'+xml(slide.source_name)+'"/>'+
  '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'+
  '<p:blipFill><a:blip r:embed="'+relId+'"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'+
  '<p:spPr><a:xfrm><a:off x="'+x+'" y="'+y+'"/><a:ext cx="'+width+'" cy="'+height+'"/></a:xfrm>'+
  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln><a:noFill/></a:ln></p:spPr></p:pic>';
}
function materialSlide(slide,index){
 shapeId=2;
 const title=cut(slide.source_group+" · "+slide.source_name,75);
 const items=[rect(0,0,W,H,COLORS.paper),rect(0,0,W,940000,COLORS.blue),
  rect(0,910000,W,22000,COLORS.teal),
  textBox(title,520000,220000,11000000,520000,2010,{color:COLORS.white,bold:true}),
  textBox("第 "+(index+3)+" 页 · "+(slide.page||1)+"/"+(slide.total||1)+
    (slide.generated?" · 系统生成摘要":""),700000,6490000,10800000,200000,1050,{color:COLORS.muted})];
 if(slide.kind==="image"){
  items.push(imageShape(slide));
 }else{
  items.push(rect(680000,1190000,10800000,5000000,COLORS.white,COLORS.line));
  items.push(textBox(slide.text||"未提供可展示文字",960000,1390000,10200000,4600000,
   1590,{color:COLORS.ink,anchor:"t"}));
 }
 return slideXml(items);
}

const wrap=inner=> '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+inner;
function buildPaymentPptx(project,payments,contracts,dossier={slides:[],attachments:[]}){
 if(!project?.id||!project?.name)throw Error("会议基本资料缺失");
 const rows=buildPaymentRows(payments,contracts);
 const signed=(contracts||[]).filter(x=>x.status==="已签署"&&!x.deleted_at&&x.category!=="企业赞助")
  .reduce((sum,x)=>sum+cents(x.amount),0)/100;
 const stats={signed,paid:(payments||[]).filter(p=>p.status==="已付款").reduce((sum,x)=>sum+cents(x.amount),0)/100,
  pending:(payments||[]).filter(p=>p.status!=="已付款"&&p.status!=="已驳回").reduce((sum,x)=>sum+cents(x.amount),0)/100};
 const materialPages=dossier.slides||[];
 const slides=[first(project),financeSlide(project,rows,stats),
  ...materialPages.map((m,i)=>materialSlide(m,i))];
 const zip=new PizZip();
 const contentTypes='<Types xmlns="'+CT+'">'+
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'+
  '<Default Extension="xml" ContentType="application/xml"/>'+
  '<Default Extension="png" ContentType="image/png"/>'+
  '<Default Extension="jpg" ContentType="image/jpeg"/>'+
  '<Default Extension="jpeg" ContentType="image/jpeg"/>'+
  '<Default Extension="pdf" ContentType="application/pdf"/>'+
  '<Default Extension="docx" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document"/>'+
  '<Default Extension="doc" ContentType="application/msword"/>'+
  '<Default Extension="pptx" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation"/>'+
  '<Default Extension="ppt" ContentType="application/vnd.ms-powerpoint"/>'+
  '<Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>'+
  '<Default Extension="xls" ContentType="application/vnd.ms-excel"/>'+
  '<Default Extension="txt" ContentType="text/plain"/>'+
  '<Default Extension="csv" ContentType="text/csv"/>'+
  '<Default Extension="webp" ContentType="image/webp"/>'+
  '<Default Extension="gif" ContentType="image/gif"/>'+
  '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'+
  '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'+
  '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'+
  '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'+
  slides.map((_,i)=>'<Override PartName="/ppt/slides/slide'+(i+1)+'.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>').join("")+
  '</Types>';
 zip.file("[Content_Types].xml",wrap(contentTypes));
 zip.file("_rels/.rels",rels(rel("rId1","officeDocument","ppt/presentation.xml")));
 zip.file("ppt/presentation.xml",wrap('<p:presentation xmlns:p="'+P+'" xmlns:r="'+R+'" xmlns:a="'+A+'">'+
  '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'+
  '<p:sldIdLst>'+slides.map((_,i)=>'<p:sldId id="'+(256+i)+'" r:id="rId'+(i+2)+'"/>').join("")+'</p:sldIdLst>'+
  '<p:sldSz cx="'+W+'" cy="'+H+'" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/>'+
  '<p:defaultTextStyle/></p:presentation>'));
 zip.file("ppt/_rels/presentation.xml.rels",rels(
  rel("rId1","slideMaster","slideMasters/slideMaster1.xml")+
  slides.map((_,i)=>rel("rId"+(i+2),"slide","slides/slide"+(i+1)+".xml")).join("")
 ));
 const grp='<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'+
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
 zip.file("ppt/slideMasters/slideMaster1.xml",wrap(
  '<p:sldMaster xmlns:a="'+A+'" xmlns:r="'+R+'" xmlns:p="'+P+'">'+
   '<p:cSld><p:spTree>'+grp+'</p:spTree></p:cSld>'+
   '<p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" tx1="dk1" tx2="dk2" hlink="hlink" folHlink="folHlink"/>'+
   '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'+
   '<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>'
 ));
 zip.file("ppt/slideMasters/_rels/slideMaster1.xml.rels",rels(
  rel("rId1","slideLayout","../slideLayouts/slideLayout1.xml")+
  rel("rId2","theme","../theme/theme1.xml")
 ));
 zip.file("ppt/slideLayouts/slideLayout1.xml",wrap(
  '<p:sldLayout xmlns:p="'+P+'" xmlns:a="'+A+'" xmlns:r="'+R+'" type="blank" preserve="1">'+
   '<p:cSld name="空白版式"><p:spTree>'+grp+'</p:spTree></p:cSld>'+
   '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'
 ));
 zip.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels",rels(rel("rId1","slideMaster","../slideMasters/slideMaster1.xml")));
 zip.file("ppt/theme/theme1.xml",wrap(
  '<a:theme xmlns:a="'+A+'" name="会规智云归档主题"><a:themeElements>'+
  '<a:clrScheme name="档案蓝"><a:dk1><a:sysClr val="windowText" lastClr="152B47"/></a:dk1>'+
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'+
  '<a:dk2><a:srgbClr val="183858"/></a:dk2><a:lt2><a:srgbClr val="F6F9FC"/></a:lt2>'+
  ['0CA5A9','54769B','77BABB','92A9BD','9DD4D3','7387A3'].map((c,i)=>'<a:accent'+(i+1)+'><a:srgbClr val="'+c+'"/></a:accent'+(i+1)+'>').join('')+
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>'+
  '<a:fontScheme name="会规字体"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface="Arial"/></a:majorFont>'+
  '<a:minorFont><a:latin typeface="Aptos"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface="Arial"/></a:minorFont></a:fontScheme>'+
  '<a:fmtScheme name="Minimal"><a:fillStyleLst><a:solidFill><a:schemeClr val="accent1"/></a:solidFill>'+
  '<a:solidFill><a:schemeClr val="accent2"/></a:solidFill><a:solidFill><a:schemeClr val="accent3"/></a:solidFill></a:fillStyleLst>'+
  '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:ln>'+
  '<a:ln w="12700"><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></a:ln>'+
  '<a:ln w="19050"><a:solidFill><a:schemeClr val="accent3"/></a:solidFill></a:ln></a:lnStyleLst>'+
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'+
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="lt1"/></a:solidFill><a:solidFill><a:schemeClr val="lt2"/></a:solidFill><a:solidFill><a:schemeClr val="dk2"/></a:solidFill></a:bgFillStyleLst>'+
  '</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'
 ));
 slides.forEach((slide,i)=>{
  zip.file("ppt/slides/slide"+(i+1)+".xml",slide);
  const material=i>=2?materialPages[i-2]:null;
  const imageRel=material?.kind==="image"?
   rel("rId2","image","../media/material"+(i-1)+"."+(material.mime==="image/png"?"png":"jpg")):"";
  zip.file("ppt/slides/_rels/slide"+(i+1)+".xml.rels",
   rels(rel("rId1","slideLayout","../slideLayouts/slideLayout1.xml")+imageRel));
  if(imageRel)zip.file("ppt/media/material"+(i-1)+"."+
   (material.mime==="image/png"?"png":"jpg"),material.image);
 });
 // Full source bytes are bundled for independent extraction, even when a
 // hosting environment cannot rasterize an Office/PDF original on slides.
 const manifest=[];
 (dossier.attachments||[]).forEach((item,i)=>{
  const filename="original-"+String(i+1).padStart(3,"0")+"-"+
   String(item.filename||"source.bin").replace(/[\\/:*?"<>|]/g,"_").slice(0,100);
  zip.file("ppt/embeddings/"+filename,item.bytes);
  manifest.push(filename+" | "+String(item.kind||"")+" | "+String(item.id||""));
 });
 if(manifest.length)zip.file("ppt/embeddings/manifest.txt",manifest.join("\n"));

 return zip.generate({type:"nodebuffer",compression:"DEFLATE",compressionOptions:{level:6}});
}
module.exports={buildPaymentPptx,buildPaymentRows};

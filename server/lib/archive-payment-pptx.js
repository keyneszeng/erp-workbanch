"use strict";
/**
 * Generate a two-section Office Open XML presentation from verified project
 * finance records. PizZip is already installed for DOCX templates and works
 * on Node and Cloudflare without native fonts, spawn or a template file.
 *
 * Slide 1: name, date and association.
 * Slide 2: payment-to-contract comparison; continuation pages only if needed.
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
 const paras=String(text??"").split("\n").slice(0,6).map(line=>
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
function financeSlide(project,rows,stats,page,of){
 shapeId=2;
 const shapes=[rect(0,0,W,H,COLORS.paper),rect(0,0,W,1080000,COLORS.blue),
  rect(0,1050000,W,30000,COLORS.teal),
  textBox("付款明细对照表"+(page>0?"（续）":""),520000,240000,10000000,480000,2600,{color:COLORS.white,bold:true}),
  textBox(cut(project.name,35),530000,700000,10700000,240000,1300,{color:"C7E5ED"}),
  textBox("关联合同总额："+money(stats.signed),520000,1250000,3700000,300000,1350,{color:COLORS.blue,bold:true}),
  textBox("实际已付："+money(stats.paid),4300000,1250000,3100000,300000,1350,{color:COLORS.blue,bold:true}),
  textBox("待付："+money(stats.pending),7900000,1250000,3700000,300000,1350,{color:COLORS.blue,bold:true})];
 const xs=[520000,980000,2410000,4550000,6420000,7910000,9340000,11660000];
 const cols=["序号","类目","收款方 / 付款单","关联合同额","本笔金额","付款状态","凭证"];
 const yTop=1860000,headerH=470000,rowH=395000;
 for(let c=0;c<cols.length;c++){
  const x=xs[c],w=xs[c+1]-x;
  shapes.push(rect(x,yTop,w,headerH,COLORS.blue));
  shapes.push(textBox(cols[c],x+17000,yTop+25000,w-34000,headerH-50000,1240,{color:COLORS.white,bold:true,align:"ctr"}));
 }
 const body=rows.length?rows:[{no:"—",type:"",payee:"本会议尚无付款记录",id:"",
  contract:null,amount:0,status:"",receipt:""}];
 for(let i=0;i<body.length;i++){
  const row=body[i],yy=yTop+headerH+i*rowH;
  const values=[String(row.no),cut(row.type,10),cut(row.payee,15)+"\n"+cut(row.id,19),
   row.contract===null?"待关联":money(row.contract),money(row.amount),
   row.status, row.receipt];
  for(let c=0;c<values.length;c++){
   const x=xs[c],w=xs[c+1]-x,fill=i%2===0?COLORS.white:COLORS.stripe;
   shapes.push(rect(x,yy,w,rowH,fill,COLORS.line));
   shapes.push(textBox(values[c],x+16000,yy+10000,w-32000,rowH-20000,c===2?1060:1200,{
    color:c===6&&row.receipt==="未附回单"?COLORS.warn:COLORS.ink,
    align:c===0||c>=3?"ctr":"l",bold:c===4
   }));
  }
 }
 const diff=Math.round((cents(stats.signed)-cents(stats.paid)))/100;
 shapes.push(textBox("核对说明：关联合同额按同名签约方匹配，多笔付款可能重复展示同一合同金额；未匹配显示“待关联”。",520000,6090000,11000000,250000,1070,{color:COLORS.muted}));
 shapes.push(textBox("本会议已签合同－实际已付："+money(diff)+"；实际已付仅汇总状态为“已付款”的记录。",520000,6340000,10800000,230000,1100,{color:COLORS.blue}));
 shapes.push(textBox("会规智云 · 财务汇总 / 第 "+(page+2)+" / "+of+" 页",9600000,6530000,2100000,200000,850,{color:COLORS.muted,align:"r"}));
 return slideXml(shapes);
}
const wrap=inner=> '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+inner;
function buildPaymentPptx(project,payments,contracts){
 if(!project?.id||!project?.name)throw Error("会议基本资料缺失");
 const rows=buildPaymentRows(payments,contracts);
 const signed=(contracts||[]).filter(x=>x.status==="已签署"&&!x.deleted_at&&x.category!=="企业赞助")
  .reduce((sum,x)=>sum+cents(x.amount),0)/100;
 const stats={signed,paid:(payments||[]).filter(p=>p.status==="已付款").reduce((sum,x)=>sum+cents(x.amount),0)/100,
  pending:(payments||[]).filter(p=>p.status!=="已付款"&&p.status!=="已驳回").reduce((sum,x)=>sum+cents(x.amount),0)/100};
 const pages=[];for(let i=0;i<rows.length;i+=9)pages.push(rows.slice(i,i+9));
 if(!pages.length)pages.push([]);
 const slides=[first(project),...pages.map((x,i)=>financeSlide(project,x,stats,i,pages.length+1))];
 const zip=new PizZip();
 const contentTypes='<Types xmlns="'+CT+'">'+
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'+
  '<Default Extension="xml" ContentType="application/xml"/>'+
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
 slides.forEach((s,i)=>{
  zip.file("ppt/slides/slide"+(i+1)+".xml",s);
  zip.file("ppt/slides/_rels/slide"+(i+1)+".xml.rels",rels(rel("rId1","slideLayout","../slideLayouts/slideLayout1.xml")));
 });
 return zip.generate({type:"nodebuffer",compression:"DEFLATE",compressionOptions:{level:6}});
}
module.exports={buildPaymentPptx,buildPaymentRows};

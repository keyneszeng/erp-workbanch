const qs = new URLSearchParams(location.search);
const token = qs.get("token") || "";
const $ = selector => document.querySelector(selector);
function status(text, isError = false) {
  $("#message").className = isError ? "error" : "status";
  $("#message").textContent = text;
}
async function load() {
  if (!/^[a-f0-9]{48,64}$/.test(token)) {
    $("#title").textContent = "邀请链接无效"; status("请联系会议筹备负责人重新获取邀请函。",true); return;
  }
  try {
    const response = await fetch("/api/public/prep-invitation?token="+encodeURIComponent(token),{
      cache:"no-store",referrerPolicy:"no-referrer"
    });
    const body = await response.json();
    if (!response.ok) throw Error(body.error?.message || "邀请链接不可用");
    $("#title").textContent = body.title;
    $("#subtitle").textContent = body.template;
    const container=$("#paragraphs"); container.replaceChildren();
    for (const paragraph of body.paragraphs || []) {
      const p=document.createElement("p");p.textContent=paragraph;container.appendChild(p);
    }
    $("#pdf").href="/api/public/prep-invitation-pdf?token="+encodeURIComponent(token);
    $("#actions").hidden=false;
    if (body.response) {
      status("您已回复该邀请："+(body.response==="CONFIRM"?"确认参加":"暂不接受"));
      $("#confirm").disabled=true; $("#decline").disabled=true;
    } else {
      status("请核对内容并选择确认或拒绝；操作会记录到对应会议项目。");
    }
  } catch (error) {
    $("#title").textContent="邀请函无法打开";$("#actions").hidden=true;status(error.message||"请求失败",true);
  }
}
async function answer(action) {
  if (!window.confirm(action==="CONFIRM"?"确认接受这份邀请？":"确认暂不接受这份邀请？")) return;
  $("#confirm").disabled=true; $("#decline").disabled=true;
  try {
    const res=await fetch("/api/public/prep-invitation/respond",{
      method:"POST",headers:{"Content-Type":"application/json"},
      referrerPolicy:"no-referrer",
      body:JSON.stringify({token,action})
    });
    const data=await res.json();
    if (!res.ok) throw Error(data.error?.message||"操作失败");
    status(action==="CONFIRM"?"已确认，感谢您的回复。":"已记录您的回复。");
  } catch(e) { status(e.message||"回复失败",true);$("#confirm").disabled=false;$("#decline").disabled=false; }
}
$("#confirm").addEventListener("click",()=>answer("CONFIRM"));
$("#decline").addEventListener("click",()=>answer("DECLINE"));
load();

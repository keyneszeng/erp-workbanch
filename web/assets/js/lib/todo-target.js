/**
 * 待办类型 -> 精确的可达业务落点。
 * 无 DOM/网络依赖，能单独运行回归测试；最终访问权限仍由 nav.reachable 校验。
 */
export function targetForTodo(t) {
  switch (t.kind) {
    case "审批": return `approvals/${t.ref || t.pid}`;
    case "待核销":
    case "核销": return `verify/${t.pid}`;
    case "付款": return `finance/${t.pid}`;
    case "筹备":
    case "结算":
    case "归档":
    case "变更落账": return `projects/${t.pid}`;
    default: return t.go || "dashboard";
  }
}

const BADGES = {
  "审批": "待审批",
  "筹备": "待筹备",
  "待核销": "待核销",
  "核销": "待核销",
  "付款": "待付款",
  "结算": "已核销",
  "归档": "已结算",
  "变更落账": "待落账"
};
export function badgeForTodo(t) {
  return BADGES[t.kind] || "待处理";
}

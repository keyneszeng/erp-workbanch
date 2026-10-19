/**
 * Durable Object —— 整个 ERP 的数据库宿主
 *
 * 为什么用 DO 而不是 D1：
 *   1) DO 的 ctx.storage.sql 是「同步」API，和现有 node:sqlite 的调用方式一致，
 *      141 处 db.prepare().all()/get()/run() 一行都不用改；
 *   2) D1 是异步 API，改造成本是把全部业务代码改成 async/await，风险高得多；
 *   3) DO 实例天然串行，SQLite 不会出现并发写冲突。
 *
 * 全部业务逻辑（路由、鉴权、流程、导出）都在同一个 DO 里跑，
 * 请求通过 Worker 转发进来，避免跨实例共享状态的问题。
 */
import { attachDurableObject, migrate } from "../server/lib/db.js";
import { seed } from "../server/lib/seed.js";
import { pruneSessions } from "../server/lib/auth.js";
import { handle } from "../server/lib/app.js";
import { makeReq, makeRes, toResponse } from "./adapter.mjs";

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export class ErpDatabase {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;

    // 把 DO 的 SQL 存储挂到 db 层，之后所有 db.prepare() 都落到这里
    attachDurableObject(ctx);
    migrate();
    this.seeded = seed();
    try {
      pruneSessions();
    } catch {
      /* 清理过期会话失败不影响服务 */
    }
  }

  async fetch(request) {
    const bodyText = WRITE_METHODS.has(request.method) ? await request.text() : "";
    const req = makeReq(request, bodyText);
    const res = makeRes();
    await handle(req, res);
    return toResponse(res);
  }
}

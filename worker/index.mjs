/**
 * Cloudflare Worker 入口
 *
 * 静态资源交给 Workers Assets（./web 目录）托管，
 * 只有 /api/* 会进到这里，再转发给唯一的 Durable Object 实例处理。
 *
 * 这样做的副作用（正面）：会话表只有一个实例在管，
 * 之前 Vercel 上「换实例导致全体 401 / 登出只在签发实例生效」的问题自然消失。
 */
import { ErpDatabase } from "./do.mjs";

export { ErpDatabase };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 非 API 请求交给静态资源层（理论上 run_worker_first 已过滤，这里兜底）
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    const id = env.ERP_DB.idFromName("main");
    const stub = env.ERP_DB.get(id);
    return stub.fetch(request);
  }
};

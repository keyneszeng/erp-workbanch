/**
 * Node 风格 req/res 适配器
 *
 * 目的：让 server/ 下 5000 行既有业务代码在 Cloudflare Worker 里原样运行。
 * Worker 拿到的是 Web 标准 Request，而业务代码用的是 node:http 的 req/res。
 * 这里把前者包装成后者需要的最小接口，再把收集到的响应还原成 Response。
 *
 * 只实现业务代码真正用到的方法：
 *   req.on("data"|"end"|"error") / req.resume() / req.method / req.url / req.headers / req.socket
 *   res.writeHead() / res.setHeader() / res.end()
 */

function toHeaderObject(headers) {
  const out = {};
  for (const [k, v] of headers) out[k.toLowerCase()] = v;
  return out;
}

/**
 * @param {Request} request 原始 Web Request
 * @param {ArrayBuffer|null} bodyBuffer 已读出的请求体原始字节（GET 等为 null）
 */
export function makeReq(request, bodyBuffer) {
  const url = new URL(request.url);
  const headers = toHeaderObject(request.headers);
  // 必须是原始字节：照片 / PDF 走二进制上传，转成 utf8 字符串会把文件损坏
  const chunks = bodyBuffer && bodyBuffer.byteLength ? [Buffer.from(bodyBuffer)] : [];
  const clientIp = headers["cf-connecting-ip"] || "";

  return {
    method: request.method,
    url: url.pathname + url.search,
    headers,
    socket: { remoteAddress: clientIp },
    secure: url.protocol === "https:",
    on(event, fn) {
      if (event === "data") {
        for (const c of chunks) fn(c);
      } else if (event === "end") {
        fn();
      }
      return this;
    },
    resume() {}
  };
}

export function makeRes() {
  const out = { status: 200, headers: {}, chunks: [] };
  const res = {
    writeHead(status, headers) {
      out.status = status;
      if (headers) for (const [k, v] of Object.entries(headers)) out.headers[k] = v;
      return res;
    },
    setHeader(k, v) {
      out.headers[k] = v;
      return res;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        out.chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
      }
      return res;
    },
    get _out() {
      return out;
    }
  };
  return res;
}

export function toResponse(res) {
  const out = res._out;
  const body = Buffer.concat(out.chunks);
  const headers = new Headers();
  for (const [k, v] of Object.entries(out.headers)) {
    if (k.toLowerCase() === "content-length") continue; // 交给运行时计算，避免长度不一致
    headers.set(k, String(v));
  }
  return new Response(body, { status: out.status, headers });
}

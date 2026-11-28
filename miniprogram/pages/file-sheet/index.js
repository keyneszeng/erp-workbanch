// XLSX 原表格预览页：用 CSS Grid 还原行列与合并单元格，不改原件、不转 PDF。
const app = getApp();

Page({
  data: {
    name: "表格原件", loading: true, error: "",
    sheets: [], current: 0, gridStyle: "", cells: []
  },

  onLoad(query) {
    const key = String(query.key || "");
    const name = String(query.name || "表格原件");
    this.setData({ name });
    if (!/^[a-f0-9]{32}\.xlsx$/i.test(key)) {
      this.setData({ loading: false, error: "无效的表格文件标识" });
      return;
    }
    app.api("/uploads/" + encodeURIComponent(key) + "?preview=table")
      .then(data => {
        const sheets = data?.sheets || [];
        if (!sheets.length) { this.setData({ loading: false, error: "这张表没有可预览的内容" }); return; }
        this.setData({ sheets, loading: false });
        this.buildSheet(0);
      })
      .catch(err => this.setData({ loading: false, error: err.message || "表格读取失败" }));
  },

  // 把 sheet 的 cells/merges 摊平成带 grid 定位的单元格列表。
  buildSheet(index) {
    const s = this.data.sheets[index];
    if (!s) return;
    const map = new Map();
    for (const c of s.cells || []) map.set(c.r + ":" + c.c, c);
    const mergeStart = new Map(), covered = new Set();
    for (const m of s.merges || []) {
      mergeStart.set(m.r + ":" + m.c, m);
      for (let r = m.r; r < m.r + m.rs; r++)
        for (let c = m.c; c < m.c + m.cs; c++)
          if (r !== m.r || c !== m.c) covered.add(r + ":" + c);
    }
    const widths = new Map((s.widths || []).map(w => [w.col, w.width]));
    const cols = Math.max(1, Math.min(60, s.colsCount || 1));
    const colSize = [];
    for (let c = 1; c <= cols; c++) colSize.push(Math.max(80, Math.min(240, widths.get(c) || 100)));
    const cells = [];
    for (let r = 1; r <= (s.rows || 0); r++) {
      for (let c = 1; c <= cols; c++) {
        if (covered.has(r + ":" + c)) continue;
        const cell = map.get(r + ":" + c);
        const merge = mergeStart.get(r + ":" + c);
        const cs = merge ? merge.cs : 1, rs = merge ? merge.rs : 1;
        cells.push({
          key: r + ":" + c,
          v: cell ? cell.v : "",
          num: !!(cell && cell.t === "n"),
          style: "grid-column:" + c + "/span " + cs + ";grid-row:" + r + "/span " + rs + ";"
        });
      }
    }
    this.setData({
      current: index,
      cells,
      gridStyle: "grid-template-columns:" + colSize.map(w => w + "rpx").join(" ") + ";"
    });
  },

  switchSheet(e) { this.buildSheet(Number(e.currentTarget.dataset.index)); }
});

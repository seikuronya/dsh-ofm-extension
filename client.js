/* dsh-ofm-extension — 客户端半边：设置页「模型测活」面板。
 * 形态与 dsh-think-translate / dsh-our-free-model 一致：
 *   window.__ModuleLoader__.load({ id, factory(require){ ... exports.inject/apply } })
 * 数据全部走本插件同源路由 /api/model-probe/*，判定与持久化在宿主侧。 */
window.__ModuleLoader__.load({
  id: "dsh-ofm-extension",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var React = react.default !== undefined ? react.default : react;
    var createElement = function (type, props) {
      var children = [];
      for (var i = 2; i < arguments.length; i++) children.push(arguments[i]);
      return React.createElement.apply(React, [type, props].concat(children));
    };
    var Fragment = React.Fragment;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useCallback = React.useCallback;
    var useMemo = React.useMemo;

    var primitives = null;
    try { primitives = require("@deepseek-ai/dsh-client-ui-primitives"); } catch (e) { primitives = null; }
    var IconProbe = primitives && primitives.IconThinkOutline16 ? primitives.IconThinkOutline16 : null;

    var PLUGIN_VERSION = "0.3.0";

    // 相对页面 base 解析，反代子路径部署下仍正确（OFM #54 教训）。
    var API = (function () {
      try { return new URL("api/model-probe", document.baseURI).pathname; } catch (e) { return "/api/model-probe"; }
    })();

    function api(path, options) {
      var timeout = options && options.timeout !== undefined ? options.timeout : 10000;
      var fetchOptions = {};
      for (var k in options) if (k !== "timeout") fetchOptions[k] = options[k];
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, timeout);
      return fetch(API + path, Object.assign({ redirect: "error", signal: ctrl.signal }, fetchOptions))
        .then(function (response) {
          return response.text().then(function (text) {
            var payload;
            try { payload = text === "" ? {} : JSON.parse(text); } catch (e) { payload = { error: text.slice(0, 200) }; }
            if (!response.ok) throw new Error(payload && payload.error ? payload.error : "HTTP " + response.status);
            return payload;
          });
        })
        .finally(function () { clearTimeout(timer); });
    }
    var post = function (path, body, timeout) {
      return api(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? "{}" : JSON.stringify(body),
        timeout: timeout,
      });
    };

    // ── i18n ────────────────────────────────────────────────────────────────
    var UI = {
      zh: {
        section: "模型测活",
        title: "模型可用性矩阵",
        intro: "测试模型选项中所有可用模型，结果标注在每行尾部。",
        runDeep: "全量测试",
        runQuick: "快速读取",
        stop: "停止",
        settings: "设置",
        deepLabel: "自动全量测试（真实发送最小请求，会计入调用量）",
        timeoutLabel: "单模型超时（秒）",
        save: "保存",
        saved: "已保存",
        running: "测试中",
        doneAt: "上次完成",
        never: "尚未测试",
        rows: "行",
        ofmOn: "已复用 Our Free Model 实测结果",
        ofmOff: "Our Free Model 未提供实测数据",
        ofmVerdicts: "条实测判定",
        refresh: "刷新",
        col: { provider: "渠道", model: "模型", status: "状态", detail: "说明", latency: "延迟" },
        st: {
          green: "可用 · 免费",
          yellow: "可用 · 计费",
          gray: "不可用 · 额度/费用不足",
          red: "不可用 · 无法连接",
          unknown: "未测",
        },
        stShort: { green: "免费", yellow: "计费", gray: "额度不足", red: "连不上", unknown: "未测" },
        cost: {
          "ofm:verdict": "OFM 判定", "ofm:free-lane": "OFM 免密车道", "ofm:lane": "OFM 车道",
          "ofm:region-co-paid": "OFM 地区共付", "ofm:eac-co-paid": "OFM 共付(EAC)", "ofm:kilo-free": "OFM 免费(Kilo)",
          "ofm:aggregate-key": "自带 Key", "ofm:aggregate": "聚合车道",
          "catalog:free-wording": "目录标注免费", "catalog:paid-wording": "目录标注计费",
          "catalog:multiplier": "积分倍率计费", "catalog:provider-free": "渠道名含 free", "default:assumed-paid": "默认按计费",
        },
        errLoad: "读取失败",
        empty: "还没有结果——先点「快速读取」或「全量测试」。",
        aborted: "本轮已中止（部分结果已保存）",
        partial: "中途中止",
      },
      en: {
        section: "Model Probe",
        title: "Model availability matrix",
        intro: "Tests every model in the picker; the verdict is aligned at the end of each row.",
        runDeep: "Full test",
        runQuick: "Quick read",
        stop: "Stop",
        settings: "Settings",
        deepLabel: "Automatic full test (sends one minimal request per model — counts against usage)",
        timeoutLabel: "Per-model timeout (s)",
        save: "Save",
        saved: "Saved",
        running: "Testing",
        doneAt: "Last run",
        never: "Never tested",
        rows: "rows",
        ofmOn: "Reusing Our Free Model probe results",
        ofmOff: "No Our Free Model data",
        ofmVerdicts: "reused verdicts",
        refresh: "Refresh",
        col: { provider: "Provider", model: "Model", status: "Status", detail: "Detail", latency: "Latency" },
        st: {
          green: "OK · free",
          yellow: "OK · paid",
          gray: "Down · quota/credits",
          red: "Down · unreachable",
          unknown: "Untested",
        },
        stShort: { green: "free", yellow: "paid", gray: "quota", red: "unreachable", unknown: "untested" },
        cost: {},
        errLoad: "Load failed",
        empty: "No results yet — press Quick read or Full test.",
        aborted: "Run aborted (partial results kept)",
        partial: "aborted",
      },
    };
    var LANG = (typeof navigator !== "undefined" && String(navigator.language || "").toLowerCase().indexOf("zh") === 0) ? "zh" : "en";
    var t = UI[LANG];

    // ── 样式：状态列固定尾部对齐 ─────────────────────────────────────────────
    var CSS = [
      ".mp_root{display:flex;flex-direction:column;gap:14px;max-width:980px;color:var(--dsw-alias-label-primary,#e8e8e8);font-size:13px;padding:4px 2px 24px}",
      ".mp_head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}",
      ".mp_title{font-size:16px;font-weight:600;margin:0}",
      ".mp_ver{opacity:.45;font-size:11px}",
      ".mp_intro{margin:0;opacity:.65}",
      ".mp_chips{display:flex;gap:8px;flex-wrap:wrap}",
      ".mp_chip{display:inline-flex;align-items:center;gap:6px;border:.5px solid var(--dsw-alias-border-l3,#3a3a3a);border-radius:99px;padding:3px 10px;font-size:12px}",
      ".mp_dot{width:9px;height:9px;border-radius:50%;flex:none}",
      ".mp_dot.green{background:#3ecf8e;box-shadow:0 0 6px #3ecf8e55}",
      ".mp_dot.yellow{background:#eab308;box-shadow:0 0 6px #eab30855}",
      ".mp_dot.gray{background:#8b9099}",
      ".mp_dot.red{background:#f0525f;box-shadow:0 0 6px #f0525f55}",
      ".mp_dot.unknown{background:#555;border:1px dashed #888}",
      ".mp_bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
      ".mp_btn{border:.5px solid var(--dsw-alias-border-l3,#3a3a3a);background:transparent;color:inherit;border-radius:8px;height:30px;padding:0 12px;font:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:6px}",
      ".mp_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#ffffff14)}",
      ".mp_btn:disabled{opacity:.4;cursor:default}",
      ".mp_btn.primary{background:var(--dsw-alias-button-primary-fill,#3b82f6);color:#fff;border-color:transparent}",
      ".mp_progress{flex:1;min-width:120px;height:6px;border-radius:99px;background:#ffffff18;overflow:hidden;display:none}",
      ".mp_progress i{display:block;height:100%;background:linear-gradient(90deg,#3ecf8e,#eab308);transition:width .3s}",
      ".mp_note{font-size:11px;opacity:.55}",
      ".mp_settings{display:flex;flex-direction:column;gap:8px;border:.5px solid var(--dsw-alias-border-l3,#3a3a3a);border-radius:12px;padding:10px 12px}",
      ".mp_settings label{display:flex;align-items:center;gap:8px;font-size:12px}",
      ".mp_settings input[type=number]{width:76px;background:var(--dsw-alias-bg-layer-1,#1d1d1d);color:inherit;border:.5px solid #3a3a3a;border-radius:6px;height:26px;padding:0 8px;font:inherit}",
      ".mp_saved{font-size:11px;color:#3ecf8e;opacity:0;transition:opacity .2s}",
      ".mp_saved.on{opacity:1}",
      ".mp_group{margin-top:8px}",
      ".mp_ghead{display:flex;align-items:center;gap:8px;padding:6px 2px;font-size:12px;opacity:.7;border-bottom:.5px solid var(--dsw-alias-border-l2,#333)}",
      ".mp_gcount{margin-left:auto;display:flex;gap:6px}",
      ".mp_gmini{display:inline-flex;align-items:center;gap:3px;font-size:11px}",
      "table.mp_table{width:100%;border-collapse:collapse;table-layout:fixed}",
      "table.mp_table th{text-align:left;font-weight:500;font-size:11px;opacity:.5;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2,#333)}",
      "table.mp_table td{padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1,#2a2a2a);vertical-align:middle;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      "col.mp_c_model{width:34%}col.mp_c_detail{width:38%}col.mp_c_lat{width:7%}col.mp_c_status{width:21%}",
      "td.mp_c_lat{text-align:right;font-variant-numeric:tabular-nums;opacity:.6;font-size:12px}",
      "/* 尾部对齐核心：状态列定宽 + 徽标在列内右端成一条直线 */",
      "td.mp_status{text-align:right;white-space:nowrap}",
      "span.mp_badge{display:inline-flex;align-items:center;gap:6px;justify-content:flex-end;border-radius:99px;padding:2px 10px;font-size:12px;line-height:18px;border:.5px solid transparent;min-width:132px}",
      "span.mp_badge .mp_dot{margin-right:0}",
      "span.mp_badge.green{color:#3ecf8e;border-color:#3ecf8e40;background:#3ecf8e12}",
      "span.mp_badge.yellow{color:#d9a514;border-color:#d9a51440;background:#d9a51412}",
      "span.mp_badge.gray{color:#9aa0a8;border-color:#9aa0a840;background:#9aa0a812}",
      "span.mp_badge.red{color:#f0525f;border-color:#f0525f40;background:#f0525f12}",
      "span.mp_badge.unknown{color:#888;border-color:#6666;border-bottom-style:dashed}",
      ".mp_reason{font-size:11px;opacity:.6;display:block;text-align:right;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".mp_mname{font-weight:500}",
      ".mp_mid{font-family:ui-monospace,Menlo,monospace;font-size:11px;opacity:.5;display:block;overflow:hidden;text-overflow:ellipsis}",
      ".mp_error{color:#f0525f;font-size:12px}",
      ".mp_ofm{font-size:11px;opacity:.55}",
    ].join("");

    function StyleTag() {
      return createElement("style", { dangerouslySetInnerHTML: { __html: CSS } });
    }

    function fmtTime(ms) {
      if (!ms) return "";
      var d = new Date(ms);
      var p = function (n) { return (n < 10 ? "0" : "") + n; };
      return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    }

    var ORDER = { green: 0, yellow: 1, gray: 2, red: 3, unknown: 4 };
    function colorOf(row) { return row.color || "unknown"; }

    function Badge(props) {
      var c = props.color;
      return createElement("span", { className: "mp_badge " + c },
        createElement("i", { className: "mp_dot " + c }),
        props.text || t.st[c]);
    }

    // ── 面板 ────────────────────────────────────────────────────────────────
    function Panel() {
      var s0 = useState(null); var summary = s0[0]; var setSummary = s0[1];
      var errState = useState(""); var error = errState[0]; var setError = errState[1];
      var b0 = useState(false); var busy = b0[0]; var setBusy = b0[1];
      var f0 = useState(false); var flash = f0[0]; var setFlash = f0[1];
      var deep = summary ? summary.settings && summary.settings.deepTest !== false : true;
      var d0 = useState(null); var deepDraft = d0[0]; var setDeepDraft = d0[1];
      var to0 = useState(null); var toDraft = to0[0]; var setToDraft = to0[1];

      var load = useCallback(function () {
        return api("/summary").then(function (payload) {
          setSummary(payload); setError("");
        }).catch(function (e) { setError(String(e && e.message ? e.message : e)); });
      }, []);

      useEffect(function () { load(); }, [load]);

      // 进度轮询：running 时每秒刷新一次。
      useEffect(function () {
        if (!(summary && summary.running)) return;
        var id = setInterval(load, 1000);
        return function () { clearInterval(id); };
      }, [summary && summary.running, load]);

      var act = useCallback(function (fn) {
        setBusy(true);
        Promise.resolve().then(fn).catch(function (e) { setError(String(e && e.message ? e.message : e)); }).finally(function () { setBusy(false); load(); });
      }, [load]);

      var runQuick = function () { act(function () { return post("/run", { deep: false, background: true }); }); };
      var runDeep = function () { act(function () { return post("/run", { deep: true, background: true }); }); };
      var stop = function () { act(function () { return post("/stop", {}, 5000); }); };
      var saveSettings = function () {
        var patch = {};
        if (deepDraft !== null) patch.deepTest = !!deepDraft;
        if (toDraft !== null && Number.isFinite(Number(toDraft))) patch.pingTimeoutMs = Math.max(3, Math.min(180, Number(toDraft))) * 1000;
        act(function () { return post("/settings", patch).then(function () { setFlash(true); setTimeout(function () { setFlash(false); }, 1600); }); });
      };

      var groups = useMemo(function () {
        if (!summary || !summary.rows) return [];
        var byProvider = new Map();
        for (var i = 0; i < summary.rows.length; i++) {
          var row = summary.rows[i];
          var key = row.provider;
          if (!byProvider.has(key)) byProvider.set(key, { provider: key, name: row.providerName || key, rows: [] });
          byProvider.get(key).rows.push(row);
        }
        var out = [];
        byProvider.forEach(function (g) {
          g.rows.sort(function (a, b) {
            var d = (ORDER[colorOf(a)] - ORDER[colorOf(b)]) || String(a.name).localeCompare(String(b.name));
            return d;
          });
          out.push(g);
        });
        out.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
        return out;
      }, [summary]);

      if (!summary) {
        return createElement("div", { className: "mp_root" },
          createElement(StyleTag),
          error ? createElement("p", { className: "mp_error" }, t.errLoad + ": ", error) : null,
          error ? null : createElement("p", { className: "mp_note" }, "…"));
      }

      var c = summary.counts || {};
      var running = !!summary.running;
      var pct = running && summary.progress && summary.progress.total
        ? Math.round(100 * summary.progress.done / summary.progress.total) : 0;
      var deepNow = deepDraft === null ? deep : !!deepDraft;
      var toNow = toDraft === null ? Math.round(((summary.settings && summary.settings.pingTimeoutMs) || 30000) / 1000) : toDraft;

      return createElement("div", { className: "mp_root" },
        createElement(StyleTag),
        createElement("div", { className: "mp_head" },
          createElement("h3", { className: "mp_title" }, t.title),
          createElement("span", { className: "mp_ver" }, "v" + PLUGIN_VERSION)),
        createElement("p", { className: "mp_intro" }, t.intro),
        error ? createElement("p", { className: "mp_error" }, t.errLoad + ": ", error) : null,

        // 四色汇总（徽标顺序 = 行内顺序 = 尾部对齐的列顺序）
        createElement("div", { className: "mp_chips" },
          ["green", "yellow", "gray", "red"].map(function (k) {
            return createElement("span", { className: "mp_chip", key: k },
              createElement("i", { className: "mp_dot " + k }), t.st[k], " ", String(c[k] || 0));
          }),
          c.unknown ? createElement("span", { className: "mp_chip", key: "u" },
            createElement("i", { className: "mp_dot unknown" }), t.st.unknown, " ", String(c.unknown)) : null),

        createElement("div", { className: "mp_bar" },
          createElement("button", { className: "mp_btn primary", disabled: busy || running, onClick: runDeep }, t.runDeep),
          createElement("button", { className: "mp_btn", disabled: busy || running, onClick: runQuick }, t.runQuick),
          running ? createElement("button", { className: "mp_btn", disabled: busy, onClick: stop }, t.stop) : null,
          createElement("button", { className: "mp_btn", disabled: busy || running, onClick: load }, t.refresh),
          createElement("div", { className: "mp_progress", style: { display: running ? "block" : "none" } },
            createElement("i", { style: { width: pct + "%" } })),
          running
            ? createElement("span", { className: "mp_note" }, t.running + " " + (summary.progress.done || 0) + "/" + (summary.progress.total || 0))
            : createElement("span", { className: "mp_note" },
                (summary.at ? t.doneAt + " " + fmtTime(summary.at) : t.never) +
                (summary.aborted ? " · " + t.partial : "") + " · " +
                (summary.rows ? summary.rows.length : 0) + " " + t.rows),
          summary.ofm && summary.ofm.installed
            ? createElement("span", { className: "mp_ofm" }, t.ofmOn + " (" + summary.ofm.verdicts + " " + t.ofmVerdicts + ", " + fmtTime(summary.ofm.availabilityAt) + ")")
            : createElement("span", { className: "mp_ofm" }, t.ofmOff)),

        // 设置行
        createElement("div", { className: "mp_settings" },
          createElement("label", null,
            createElement("input", {
              type: "checkbox", checked: deepNow,
              onChange: function (e) { setDeepDraft(e.target.checked); },
            }), t.deepLabel),
          createElement("label", null, t.timeoutLabel, " ",
            createElement("input", {
              type: "number", min: 3, max: 180, value: toNow,
              onChange: function (e) { setToDraft(e.target.value); },
            })),
          createElement("div", null,
            createElement("button", {
              className: "mp_btn", disabled: busy || (deepDraft === null && toDraft === null), onClick: saveSettings,
            }, t.save),
            createElement("span", { className: "mp_saved" + (flash ? " on" : "") }, t.saved))),

        // 矩阵：每 provider 一组，列 = 模型 / 说明 / 延迟 / 状态（状态列定宽，尾部对齐）
        groups.length === 0 ? createElement("p", { className: "mp_note" }, t.empty) : null,
        groups.map(function (g) {
          var mini = {};
          for (var i = 0; i < g.rows.length; i++) { var col = colorOf(g.rows[i]); mini[col] = (mini[col] || 0) + 1; }
          return createElement("div", { className: "mp_group", key: g.provider },
            createElement("div", { className: "mp_ghead" },
              createElement("b", null, g.name),
              createElement("span", { style: { opacity: .5 } }, g.provider),
              createElement("span", { className: "mp_gcount" },
                ["green", "yellow", "gray", "red", "unknown"].filter(function (k) { return mini[k]; }).map(function (k) {
                  return createElement("span", { className: "mp_gmini", key: k, title: t.st[k] },
                    createElement("i", { className: "mp_dot " + k }), String(mini[k]));
                }))),
            createElement("table", { className: "mp_table" },
              createElement("colgroup", null,
                createElement("col", { className: "mp_c_model" }),
                createElement("col", { className: "mp_c_detail" }),
                createElement("col", { className: "mp_c_lat" }),
                createElement("col", { className: "mp_c_status" })),
              createElement("thead", null, createElement("tr", null,
                createElement("th", null, t.col.model),
                createElement("th", null, t.col.detail),
                createElement("th", { style: { textAlign: "right" } }, t.col.latency),
                createElement("th", { style: { textAlign: "right" } }, t.col.status))),
              createElement("tbody", null,
                g.rows.map(function (row) {
                  var k = colorOf(row);
                  var detail = row.reason || "";
                  if (!detail && (k === "green" || k === "yellow") && row.costSource) {
                    detail = (t.cost[row.costSource] || row.costSource);
                  }
                  return createElement("tr", { key: row.key },
                    createElement("td", { title: row.model },
                      createElement("span", { className: "mp_mname" }, row.name),
                      createElement("span", { className: "mp_mid" }, row.model)),
                    createElement("td", { title: detail }, detail),
                    createElement("td", { className: "mp_c_lat" }, row.latencyMs ? Math.round(row.latencyMs) + "ms" : ""),
                    createElement("td", { className: "mp_status" },
                      createElement(Badge, { color: k, text: t.st[k] })));
                }))));
        }));
    }

    // ── 模型选项下拉的实时四色装饰 ──────────────────────────────────────────
    // 宿主下拉（dsh-client-ui-model-selection）把菜单 portal 到 body，每行是
    //   button[role="menuitemradio"] > span.optionCopy > span.modelName > span[data-provider-id][data-model-id]
    // 行 id 与宿主目录一致（provider.id / model.id），与本插件 summary.rows 的
    // key 直接对得上。装饰策略：MutationObserver 捕获菜单挂载/行重建，按行
    // 追加尾部对齐的四色徽标；触发器按钮上加同色小圆点。React 只管理它自己
    // 渲染的子节点，追加的节点在同行重渲染中存活；菜单卸载后 observer 会
    // 在下次打开时重新装饰。
    var DROPDOWN_CSS = [
      ".mpd-badge{margin-left:auto;flex:none;display:inline-flex;align-items:center;gap:5px;font-size:11px;line-height:16px;padding:1px 8px;border-radius:99px;border:.5px solid transparent;pointer-events:none}",
      ".mpd-badge i{width:7px;height:7px;border-radius:50%;flex:none}",
      ".mpd-badge.green{color:#3ecf8e;border-color:#3ecf8e40;background:#3ecf8e14}",
      ".mpd-badge.green i{background:#3ecf8e}",
      ".mpd-badge.yellow{color:#d9a514;border-color:#d9a51440;background:#d9a51414}",
      ".mpd-badge.yellow i{background:#eab308}",
      ".mpd-badge.gray{color:#9aa0a8;border-color:#9aa0a840;background:#9aa0a814}",
      ".mpd-badge.gray i{background:#8b9099}",
      ".mpd-badge.red{color:#f0525f;border-color:#f0525f40;background:#f0525f14}",
      ".mpd-badge.red i{background:#f0525f}",
      ".mpd-badge.unknown{color:#777;border-color:#6666;border-bottom-style:dashed}",
      ".mpd-badge.unknown i{background:#555;border:1px dashed #888}",
      "button[role=menuitemradio][data-mpd=gray] span[data-model-id]{opacity:.55}",
      "button[role=menuitemradio][data-mpd=red] span[data-model-id]{opacity:.55;color:#f0525f99}",
      ".mpd-trig{width:8px;height:8px;border-radius:50%;flex:none;margin-left:4px}",
      ".mpd-trig.green{background:#3ecf8e}.mpd-trig.yellow{background:#eab308}.mpd-trig.gray{background:#8b9099}.mpd-trig.red{background:#f0525f}.mpd-trig.unknown{background:#555;border:1px dashed #888}",
    ].join("");
    var BADGE_TEXT = { green: "免费", yellow: "计费", gray: "额度不足", red: "连不上", unknown: "未测" };
    var verdicts = new Map();
    var dropdownStyleInjected = false;
    var decoratePending = false;

    function injectDropdownCss() {
      if (dropdownStyleInjected || typeof document === "undefined") return;
      var el = document.createElement("style");
      el.setAttribute("data-mpd", "dropdown");
      el.textContent = DROPDOWN_CSS;
      (document.head || document.documentElement).appendChild(el);
      dropdownStyleInjected = true;
    }

    var CJK_FREE_FIX = /免费|零成本/;
    function loadVerdicts() {
      return api("/summary").then(function (payload) {
        var next = new Map();
        var rows = (payload && payload.rows) || [];
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          if (!r || !r.provider || !r.model) continue;
          var v = { color: r.color || "unknown", reason: r.reason || "" };
          // 显示层修正：旧宿主（classify v1）把 "· 免费" 误判为默认计费；
          // 在宿主重启完成迁移之前，客户端按名字直接纠正，OFM 来源不动。
          if (v.color === "yellow" && String(r.costSource || "").indexOf("ofm:") !== 0 && CJK_FREE_FIX.test(r.name || "")) {
            v = { color: "green", reason: v.reason };
          }
          next.set(r.provider + "/" + r.model, v);
        }
        verdicts = next;
        decorate();
      }).catch(function () { /* 后端未就绪：保持空表，行不装饰 */ });
    }

    function badgeFor(color, reason) {
      var b = document.createElement("span");
      b.className = "mpd-badge " + color;
      b.setAttribute("data-mpd-badge", color);
      if (reason) b.title = reason;
      var dot = document.createElement("i");
      b.appendChild(dot);
      b.appendChild(document.createTextNode(BADGE_TEXT[color] || ""));
      return b;
    }

    function decorate() {
      if (typeof document === "undefined") return;
      injectDropdownCss();
      var labels = document.querySelectorAll("span[data-model-id][data-provider-id]");
      for (var i = 0; i < labels.length; i++) {
        var label = labels[i];
        var row = label.closest("button[role=menuitemradio]");
        var key = label.getAttribute("data-provider-id") + "/" + label.getAttribute("data-model-id");
        var v = verdicts.get(key);
        var color = v ? v.color : "unknown";
        if (row) {
          var existing = row.getAttribute("data-mpd");
          if (existing !== color) {
            var old = row.querySelector("[data-mpd-badge]");
            if (old) old.remove();
            row.setAttribute("data-mpd", color);
            row.appendChild(badgeFor(color, v && v.reason ? v.reason : ""));
          } else if (!row.querySelector("[data-mpd-badge]")) {
            row.appendChild(badgeFor(color, v && v.reason ? v.reason : ""));
          }
        }
        // 触发器（已选模型）上的同色圆点
        var trigger = label.closest("button[aria-haspopup=menu]");
        if (trigger) {
          var dot = trigger.querySelector("[data-mpd-trig]");
          if (!dot || dot.getAttribute("data-mpd-trig") !== color) {
            if (dot) dot.remove();
            var d = document.createElement("span");
            d.className = "mpd-trig " + color;
            d.setAttribute("data-mpd-trig", color);
            if (v && v.reason) d.title = v.reason;
            // 放在尾部 chevron 之前，视觉上是「模型名 · 色点 · 箭头」
            trigger.insertBefore(d, trigger.lastElementChild);
          }
        }
      }
    }

    function scheduleDecorate() {
      if (decoratePending) return;
      decoratePending = true;
      requestAnimationFrame(function () {
        decoratePending = false;
        decorate();
      });
    }

    function startDropdownDecorator() {
      if (typeof document === "undefined" || typeof MutationObserver !== "function") return undefined;
      injectDropdownCss();
      loadVerdicts();
      var observer = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var added = records[i].addedNodes;
          for (var k = 0; k < added.length; k++) {
            var n = added[k];
            if (n.nodeType === 1 && (n.matches && (n.matches("[role=menu],[role=menuitemradio],button[aria-haspopup=menu]") || n.querySelector && n.querySelector("[data-model-id]")))) {
              scheduleDecorate();
              return;
            }
          }
        }
      });
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
      var poll = setInterval(loadVerdicts, 45000);
      var dispose = function () { observer.disconnect(); clearInterval(poll); };
      return dispose;
    }

    // ── 插件导出 ────────────────────────────────────────────────────────────
    var inject = ["slots"];
    function apply(ctx) {
      var disposers = [];
      try {
        var d = startDropdownDecorator();
        if (d) disposers.push(d);
      } catch (e) {
        console.warn("[dsh-ofm-extension] 下拉装饰启动失败:", e);
      }
      try {
        var sectionDispose = ctx.slots.inject("settings.section", function () {
          return ctx.slots.register(
            { name: "settings.section", id: "dsh-ofm-extension", order: 62, label: t.section },
            Panel);
        });
        disposers.push(sectionDispose);
      } catch (e) {
        console.warn("[dsh-ofm-extension] 设置页槽位注册失败:", e);
      }
      // ctx.effect 是唯一的清理通道（think-translate 同模式）。
      if (typeof ctx.effect === "function") {
        ctx.effect(function () {
          return function () { for (var i = 0; i < disposers.length; i++) { try { disposers[i](); } catch (e) {} } };
        });
      }
      return undefined;
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});

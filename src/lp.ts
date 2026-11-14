import { track } from "./track.ts";
let ref = "";
try { ref = document.referrer ? new URL(document.referrer).hostname : ""; } catch { /* noop */ }
track("lp_view", { ref: ref || "direct", mobile: matchMedia("(max-width: 760px)").matches });

// トップページを読み終えて手が空いたら、入力画面のプログラムと地図の見た目を先に取っておく（「はじめる」を押したあとが速くなる）。
// 通信量を節約する設定の端末や、遅い回線では取らない
const conn = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
if (!conn?.saveData && !/2g/.test(conn?.effectiveType ?? "")) {
  const warm = () => { for (const [href, as] of [["/assets/app.js", "script"], ["/assets/maplibre-gl.css", "style"], ["/assets/app.css", "style"]]) {
    const l = document.createElement("link"); l.rel = "prefetch"; l.href = href; l.as = as; document.head.appendChild(l); } };
  const idle = (window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  addEventListener("load", () => (idle ? idle(warm, { timeout: 4000 }) : setTimeout(warm, 2000)));
}

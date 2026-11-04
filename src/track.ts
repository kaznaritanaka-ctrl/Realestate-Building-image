// 利用状況の記録：個人を特定しない仮名のセッションIDと、許可された項目だけを送る
function sessionId(): string {
  try {
    let s = sessionStorage.getItem("tm-sid");
    if (!s) { s = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, "0")).join(""); sessionStorage.setItem("tm-sid", s); }
    return s;
  } catch { return "0000000000000000"; }
}
export const SID = sessionId();

export function track(name: string, props: Record<string, string | number | boolean | undefined> = {}) {
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props)) if (v !== undefined) clean[k] = v;
  const body = JSON.stringify({ sid: SID, name, props: clean });
  try {
    if (navigator.sendBeacon) navigator.sendBeacon("/api/event", new Blob([body], { type: "application/json" }));
    else fetch("/api/event", { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } }).catch(() => {});
  } catch { /* 計測の失敗は無視 */ }
}

export function areaBucket(sqm: number): string {
  return sqm < 100 ? "<100" : sqm < 200 ? "100-200" : sqm < 500 ? "200-500" : sqm < 1000 ? "500-1000" : sqm < 5000 ? "1000-5000" : ">=5000";
}

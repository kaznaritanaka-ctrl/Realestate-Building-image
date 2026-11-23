// 相続手続きパックの日付計算（端末内で使う純粋関数）

/** "YYYY-MM-DD" を端末ローカルの日付にする。不正なら null */
export function parseYmd(s: string | undefined | null): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** n か月後の同じ日。その月に同じ日がなければ月末（1/31 の1か月後は 2/28 か 2/29） */
export function addMonths(d: Date, n: number): Date {
  const m = d.getMonth() + n;
  const ty = d.getFullYear() + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  const last = new Date(ty, tm + 1, 0).getDate();
  return new Date(ty, tm, Math.min(d.getDate(), last));
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** 日数の差（b − a）。時刻は無視する */
export function daysBetween(a: Date, b: Date): number {
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ub - ua) / 86400000);
}

const WD = ["日", "月", "火", "水", "木", "金", "土"];
export function fmtDate(d: Date): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`;
}
export function fmtDateShort(d: Date): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * 年（西暦の下2桁）・月・日の入力を "YYYY-MM-DD" にする。
 * 下2桁が今年より後なら 1900年代とみなす（例：今年が2026年なら 26→2026、98→1998）。
 * 全部空なら ""、足りない・ありえない日付・未来の日付なら理由を返す。
 */
export type DateParts = { ok: true; value: string } | { ok: false; error: string };
export function fromParts(yy: string, m: string, d: string, today: Date): DateParts {
  yy = yy.trim(); m = m.trim(); d = d.trim();
  if (!yy && !m && !d) return { ok: true, value: "" };
  if (!/^\d{1,2}$/.test(yy)) return { ok: false, error: "年は西暦の下2桁を数字で入れてください（例：2026年なら 26）。" };
  if (!m || !d) return { ok: false, error: "月と日も選んでください。" };
  const n = Number(yy);
  const cur = today.getFullYear();
  const y = 2000 + n <= cur ? 2000 + n : 1900 + n;
  const s = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const dt = parseYmd(s);
  if (!dt) return { ok: false, error: `${y}年${Number(m)}月${Number(d)}日はありません。` };
  if (daysBetween(today, dt) > 0) return { ok: false, error: "今日より後の日付は入れられません。" };
  return { ok: true, value: s };
}

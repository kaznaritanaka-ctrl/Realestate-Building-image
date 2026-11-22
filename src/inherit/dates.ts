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

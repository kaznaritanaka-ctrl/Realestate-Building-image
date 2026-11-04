// 用途地域の既定値（MVP用の代表値。実際の指定値は自治体の都市計画で異なる）
export type ZoneKey =
  | "r1low" | "r2low" | "r1mid" | "r2mid" | "r1" | "r2" | "quasiR" | "rural"
  | "nbrCom" | "com" | "quasiInd" | "ind" | "indOnly" | "unknown";

export interface ZoneInfo {
  key: ZoneKey;
  label: string;
  bcr: number;          // 建蔽率（%）の代表値
  far: number;          // 容積率（%）の代表値
  residential: boolean; // 住居系か（道路幅員による容積率低減の係数 0.4 / 0.6）
  lowRise: boolean;     // 低層系（絶対高さ10m/12m → 3階まで）
  storeLimit: number | null; // 店舗の床面積上限の目安（㎡）。null=制限なし扱い、0=原則不可
  housingAllowed: boolean;
}

export const ZONES: Record<ZoneKey, ZoneInfo> = {
  r1low:    { key: "r1low",    label: "第一種低層住居専用地域", bcr: 50, far: 100, residential: true,  lowRise: true,  storeLimit: 0,    housingAllowed: true },
  r2low:    { key: "r2low",    label: "第二種低層住居専用地域", bcr: 60, far: 150, residential: true,  lowRise: true,  storeLimit: 150,  housingAllowed: true },
  r1mid:    { key: "r1mid",    label: "第一種中高層住居専用地域", bcr: 60, far: 200, residential: true, lowRise: false, storeLimit: 500,  housingAllowed: true },
  r2mid:    { key: "r2mid",    label: "第二種中高層住居専用地域", bcr: 60, far: 200, residential: true, lowRise: false, storeLimit: 1500, housingAllowed: true },
  r1:       { key: "r1",       label: "第一種住居地域",         bcr: 60, far: 200, residential: true,  lowRise: false, storeLimit: 3000, housingAllowed: true },
  r2:       { key: "r2",       label: "第二種住居地域",         bcr: 60, far: 200, residential: true,  lowRise: false, storeLimit: null, housingAllowed: true },
  quasiR:   { key: "quasiR",   label: "準住居地域",             bcr: 60, far: 200, residential: true,  lowRise: false, storeLimit: null, housingAllowed: true },
  rural:    { key: "rural",    label: "田園住居地域",           bcr: 50, far: 100, residential: true,  lowRise: true,  storeLimit: 0,    housingAllowed: true },
  nbrCom:   { key: "nbrCom",   label: "近隣商業地域",           bcr: 80, far: 300, residential: false, lowRise: false, storeLimit: null, housingAllowed: true },
  com:      { key: "com",      label: "商業地域",               bcr: 80, far: 400, residential: false, lowRise: false, storeLimit: null, housingAllowed: true },
  quasiInd: { key: "quasiInd", label: "準工業地域",             bcr: 60, far: 200, residential: false, lowRise: false, storeLimit: null, housingAllowed: true },
  ind:      { key: "ind",      label: "工業地域",               bcr: 60, far: 200, residential: false, lowRise: false, storeLimit: null, housingAllowed: true },
  indOnly:  { key: "indOnly",  label: "工業専用地域",           bcr: 60, far: 200, residential: false, lowRise: false, storeLimit: null, housingAllowed: false },
  unknown:  { key: "unknown",  label: "わからない（保守的に計算）", bcr: 50, far: 100, residential: true, lowRise: true, storeLimit: 0, housingAllowed: true },
};

export const ZONE_ORDER: ZoneKey[] = [
  "unknown", "r1low", "r2low", "r1mid", "r2mid", "r1", "r2", "quasiR", "rural",
  "nbrCom", "com", "quasiInd", "ind", "indOnly",
];

// 広告（アフィリエイト）の設定。ASPの提携承認後に url を入れて push すれば、結果ページに表示される。
// url が空の枠は表示しない。文言はPR表記とともに結果ページに出る。
export interface AdSlot {
  slot: string;        // /go/:slot の識別子
  use: "house" | "rental" | "other";
  url: string;         // ASPから発行されたアフィリエイトURL（未承認のうちは空）
  advertiser: string;  // 表示する広告主・サービス名
  text: string;        // リンク文言
}

export const AD_SLOTS: AdSlot[] = [
  {
    slot: "house-plan",
    use: "house",
    url: "",
    advertiser: "タウンライフ家づくり",
    text: "この土地に合う間取りプランと見積もりを、複数の住宅会社から無料で取り寄せる",
  },
  {
    slot: "land-use",
    use: "rental",
    url: "",
    advertiser: "",
    text: "賃貸経営・土地活用のプランを、複数の会社から無料で取り寄せる",
  },
  {
    slot: "land-use-other",
    use: "other",
    url: "",
    advertiser: "",
    text: "駐車場・店舗などの土地活用プランを、複数の会社から無料で取り寄せる",
  },
];

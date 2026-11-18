// 広告（アフィリエイト）の設定。ASPの提携承認後に url を入れて push すれば、結果ページに表示される。
// url が空の枠は表示しない。文言はPR表記とともに結果ページに出る。
export interface AdSlot {
  slot: string;        // /go/:slot の識別子
  use: "house" | "rental" | "other" | "sell" | "inherit";
  url: string;         // ASPから発行されたアフィリエイトURL（未承認のうちは空）
  imp?: string;        // ASPのインプレッション計測画像（通常タグに含まれていれば設定。結果ページで広告表示時に1回だけ読み込む）
  official?: string;   // 承認前にガイドページから案内するときの公式サイト（アフィリエイトではないURL）
  advertiser: string;  // 表示する広告主・サービス名
  text: string;        // リンク文言
}

export const AD_SLOTS: AdSlot[] = [
  {
    slot: "house-plan",
    use: "house",
    url: "https://townlife-aff.com/link.php?i=645b492639451&m=6aeb5a722ec59",
    imp: "https://townlife-aff.com/data.php?i=645b492639451&m=6aeb5a722ec59",
    official: "https://www.town-life.jp/home/",
    advertiser: "タウンライフ家づくり",
    text: "この方向で複数社の間取りプランと\n資金計画を無料で取り寄せる",
  },
  {
    slot: "land-use",
    use: "rental",
    url: "https://townlife-aff.com/link.php?i=A0000136&m=6aeb5a722ec59",
    imp: "https://townlife-aff.com/data.php?i=A0000136&m=6aeb5a722ec59",
    official: "https://www.town-life.jp/land/",
    advertiser: "タウンライフ土地活用",
    text: "この規模で、複数社の収益化プランと見積を無料で比較する",
  },
  {
    slot: "land-use-other",
    use: "other",
    url: "https://townlife-aff.com/link.php?i=A0000136&m=6aeb5a722ec59",
    imp: "https://townlife-aff.com/data.php?i=A0000136&m=6aeb5a722ec59",
    official: "https://www.town-life.jp/land/",
    advertiser: "タウンライフ土地活用",
    text: "この土地で、複数社の土地活用プランを無料で比較する",
  },
  {
    slot: "sell-assessment",
    use: "sell",
    // 売却単独プログラムは未申請（2026-11-18 本人判断）。当面は不動産相続の発行URLへ飛ばす暫定措置で、
    // クリックは相続プログラム側に記録される。売却プログラムを申請・承認したら正規URLに差し替える。
    url: "https://townlife-aff.com/link.php?i=6a97908a0dd80&m=6aeb5a722ec59",
    imp: "https://townlife-aff.com/data.php?i=6a97908a0dd80&m=6aeb5a722ec59",
    official: "https://www.town-life.jp/fudousan/sell.html",
    advertiser: "タウンライフ不動産（売却）",
    text: "複数社の売却査定を無料で取り寄せる",
  },
  {
    slot: "inherit-consult",
    use: "inherit",
    url: "https://townlife-aff.com/link.php?i=6a97908a0dd80&m=6aeb5a722ec59",
    imp: "https://townlife-aff.com/data.php?i=6a97908a0dd80&m=6aeb5a722ec59",
    official: "https://townlife-souzoku.jp/",
    advertiser: "タウンライフ不動産相続",
    text: "相続の相談先と見積もりを無料で比べる",
  },
];

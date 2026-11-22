// 相続手続きパックの元データ（手続きマスタ・注意事項マスタ・選択肢カード）。
// ウィザードの出力と、手続きごとの静的ページ（/guide/inherit/tetsuzuki/<id>）の両方をここから作る。
// 各項目の根拠は一次資料（官公庁・裁判所の公式ページ）で確認し、確認日を CHECKED に持つ。
// 点検は定期タスクで行う。贈与の加算期間など年ごとに変わる項目は特に注意する。
import { addDays, addMonths } from "./dates.ts";

export const CHECKED = "2026-11-23";
export const CHECKED_JA = "2026年11月23日";

export type YNU = "y" | "n" | "u";

/** ウィザードの回答。分岐にだけ使い、どこにも保存・送信しない */
export interface Answers {
  death?: string; // 亡くなった日 YYYY-MM-DD
  known?: string; // 相続を知った日（亡くなった日と違うときだけ）
  spouse?: "y" | "n";
  kids?: number; // 子の人数。0 は「子はいない」、-1 は分からない
  minor?: YNU; // 未成年の子がいるか
  parents?: number; // 子がいないとき：存命の親の人数（0〜2）、-1 は分からない
  sibs?: number; // 子も親もいないとき：兄弟姉妹の人数、-1 は分からない
  will?: YNU;
  willType?: "home" | "notary" | "moj" | "u"; // 自筆で手元にある／公正証書／法務局に保管／分からない
  debt?: YNU;
  lpref?: string; // 不動産のある都道府県
  lcity?: string; // 不動産のある市区町村
  ltypes?: LandType[];
  vacant?: YNU; // 誰も住まなくなる家があるか
  title?: YNU; // 登記の名義は亡くなった方か（n は前の代のまま）
  dpref?: string; // 亡くなった方の最後の住所（都道府県）
  dcity?: string; // 同（市区町村）
  bank?: YNU; // 預貯金・証券口座
  pension?: YNU; // 年金を受け取っていたか
  insurance?: YNU; // 死亡保険金を受け取れそうか
}

export type LandType = "home" | "land" | "farm" | "forest";
export const LAND_TYPE_LABEL: Record<LandType, string> = {
  home: "自宅など建物のある土地",
  land: "空き地・駐車場など",
  farm: "田や畑（農地）",
  forest: "山林",
};

export interface Ctx {
  a: Answers;
  death: Date | null;
  known: Date | null; // 回答がなければ death で代用する
}

export interface Due {
  date: Date | null; // 期限日（計算できないときは null）
  text: string; // 期限の決まり方（「知った日から3か月以内」など）
  urgency: "soon" | "later"; // 日付がないときの並び（早めに／その後）
  approx?: boolean; // 日付が目安（起算日を代用している、法律上は「遅滞なく」など）
}

export type Office = "city" | "moj" | "court" | "court-child" | "tax" | "nenkin" | "bank" | "insurer" | "farm" | "forest" | "family" | "notary";

export const OFFICE_LABEL: Record<Office, string> = {
  city: "市区町村役場",
  moj: "管轄の法務局",
  court: "家庭裁判所（亡くなった方の最後の住所地）",
  "court-child": "家庭裁判所（子の住所地）",
  tax: "税務署（亡くなった方の住所地）",
  nenkin: "年金事務所・街角の年金相談センター",
  bank: "各金融機関",
  insurer: "保険会社",
  farm: "農業委員会（農地のある市町村）",
  forest: "市町村の林務担当（森林のある市町村）",
  family: "相続人全員で",
  notary: "公証役場",
};

/** 期限を過ぎたときに案内する相談先 */
export const CONSULT: Record<Office, { name: string; url?: string; tel?: string }[]> = {
  moj: [
    { name: "法務局の登記手続案内（予約制）", url: "https://www.moj.go.jp/MINJI/minji05_00590.html" },
    { name: "司法書士会の相続登記相談センター（予約受付）", tel: "0120-13-7832", url: "https://www.shiho-shoshi.or.jp/inheritance_lp" },
  ],
  court: [
    { name: "家庭裁判所（申立先の一覧）", url: "https://www.courts.go.jp/saiban/tetuzuki/kasai/index.html" },
    { name: "法テラス（弁護士・司法書士の無料相談の案内）", url: "https://www.houterasu.or.jp/" },
  ],
  "court-child": [{ name: "家庭裁判所（申立先の一覧）", url: "https://www.courts.go.jp/saiban/tetuzuki/kasai/index.html" }],
  tax: [
    { name: "税務署（所在地と担当地域）", url: "https://www.nta.go.jp/about/organization/access/map.htm" },
    { name: "税理士（税理士会の無料相談など）" },
  ],
  city: [{ name: "市区町村役場の担当窓口" }],
  nenkin: [{ name: "年金事務所・ねんきんダイヤル", url: "https://www.nenkin.go.jp/tokusetsu/seikeidouitsu.html" }],
  bank: [{ name: "各金融機関の相続窓口" }],
  insurer: [{ name: "保険会社の窓口（時効を過ぎても、まず相談を）" }],
  farm: [{ name: "農地のある市町村の農業委員会" }],
  forest: [{ name: "森林のある市町村の林務担当" }],
  family: [{ name: "司法書士・弁護士などの専門家" }],
  notary: [{ name: "公証役場" }],
};

export interface Source { title: string; url: string }

export type Category = "直後" | "年金・保険" | "相続人と財産の確認" | "相続の仕方の判断" | "分け方" | "税金" | "名義変更" | "土地の届出";
export const CATEGORY_ORDER: Category[] = ["直後", "年金・保険", "相続人と財産の確認", "相続の仕方の判断", "分け方", "税金", "名義変更", "土地の届出"];

export interface Procedure {
  id: string; // 静的ページのURLにも使う
  title: string;
  cat: Category;
  detail: "full" | "light"; // 不動産系は詳しく、それ以外は期限と窓口だけ
  when: (a: Answers) => boolean;
  due: (c: Ctx) => Due;
  office: Office;
  action: string; // まず何をするか（1行）
  docs?: string[]; // 一般的に必要になるもの
  notes?: string[]; // 補足（静的ページと印刷に出す）
  sources: Source[];
  strong?: (a: Answers) => boolean; // 強調表示する条件
  summary: string; // 静的ページの説明文（120字程度）
}

const KNOWN_BEFORE_2024 = new Date(2024, 3, 1);

const S = {
  koseki86: { title: "法務省「死亡届」（戸籍法第86条）", url: "https://www.moj.go.jp/ONLINE/FAMILYREGISTER/5-4.html" },
  nenkin: { title: "日本年金機構「年金を受けている方が亡くなったとき」", url: "https://www.nenkin.go.jp/tokusetsu/seikeidouitsu.html" },
  touki: { title: "法務省「相続登記の申請義務化について」", url: "https://www.moj.go.jp/MINJI/minji05_00599.html" },
  toukiQA: { title: "法務省「相続登記の申請義務化に関するQ&A」", url: "https://www.moj.go.jp/MINJI/minji05_00565.html" },
  shinkoku: { title: "法務省「相続人申告登記について」", url: "https://www.moj.go.jp/MINJI/minji05_00602.html" },
  houtei: { title: "法務局「法定相続情報証明制度について」", url: "https://houmukyoku.moj.go.jp/homu/page7_000013.html" },
  houki: { title: "裁判所「相続の放棄の申述」", url: "https://www.courts.go.jp/saiban/syurui/syurui_kazi/kazi_06_13/index.html" },
  enchou: { title: "裁判所「相続の承認又は放棄の期間の伸長」", url: "https://www.courts.go.jp/saiban/syurui/syurui_kazi/kazi_06_25/index.html" },
  gentei: { title: "裁判所「相続の限定承認の申述」", url: "https://www.courts.go.jp/saiban/syurui/syurui_kazi/kazi_06_14/index.html" },
  kennin: { title: "裁判所「遺言書の検認」", url: "https://www.courts.go.jp/saiban/syurui/syurui_kazi/kazi_06_17/index.html" },
  hokan: { title: "法務省「自筆証書遺言書保管制度」", url: "https://www.moj.go.jp/MINJI/01.html" },
  tokudai: { title: "裁判所「特別代理人選任（親権者とその子との利益相反の場合）」", url: "https://www.courts.go.jp/saiban/syurui/syurui_kazi/kazi_06_11/" },
  kouiki: { title: "法務省「戸籍証明書等の広域交付について」", url: "https://www.moj.go.jp/MINJI/minji04_00082.html" },
  junkaku: { title: "国税庁「準確定申告」", url: "https://www.nta.go.jp/taxes/shiraberu/shinkoku/jyunkaku/" },
  ta4152: { title: "国税庁 タックスアンサー No.4152 相続税の計算", url: "https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4152.htm" },
  ta4205: { title: "国税庁 タックスアンサー No.4205 相続税の申告書の提出期限と提出先", url: "https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4205.htm" },
  ta4114: { title: "国税庁 タックスアンサー No.4114 相続税の課税対象になる死亡保険金", url: "https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4114.htm" },
  ta4124: { title: "国税庁 タックスアンサー No.4124 相続した事業の用や居住の用の宅地等の価額の特例（小規模宅地等の特例）", url: "https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4124.htm" },
  nouchi: { title: "農林水産省「農地を相続した場合の届出」", url: "https://www.maff.go.jp/j/keiei/koukai/nouchi_souzoku.html" },
  shinrin: { title: "林野庁「森林の土地の所有者届出制度」", url: "https://www.rinya.maff.go.jp/j/keikaku/todokede/" },
  koteishisan: { title: "総務省「所有者不明土地等に係る固定資産税の課題への対応」（現に所有している者の申告）", url: "https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/144643_02.html" },
  kokkokizoku: { title: "法務省「相続土地国庫帰属制度の概要」", url: "https://www.moj.go.jp/MINJI/minji05_00457.html" },
  kokusen1: { title: "国民生活センター「自宅の訪問購入に関するトラブル」", url: "https://www.kokusen.go.jp/news/data/n-20210624_1.html" },
  kokusen2: { title: "国民生活センター「原野商法の二次被害トラブル」", url: "https://www.kokusen.go.jp/news/data/n-20180125_1.html" },
  akiya: { title: "国土交通省「空家等対策の推進に関する特別措置法の一部を改正する法律」の概要", url: "https://www.mlit.go.jp/jutakukentiku/house/content/002019834.pdf" },
} satisfies Record<string, Source>;
export const SOURCES = S;

const knownBase = (c: Ctx) => c.known ?? c.death;
const has = (a: Answers, t: LandType) => (a.ltypes ?? []).includes(t);
const notNo = (v: YNU | undefined) => v !== "n";

export const PROCEDURES: Procedure[] = [
  {
    id: "shiboutodoke", title: "死亡届と火葬許可の申請", cat: "直後", detail: "light",
    when: () => true,
    due: (c) => ({ date: knownBase(c) ? addDays(knownBase(c)!, 6) : null, text: "死亡の事実を知った日から7日以内（知った日を1日目と数える）", urgency: "soon" }),
    office: "city",
    action: "多くの場合、葬儀社が提出を代行します。済んでいるか確認しましょう。",
    docs: ["死亡届（右半分が医師の死亡診断書）"],
    notes: ["提出先は、亡くなった場所・本籍地・届出人の所在地のいずれかの市区町村です。", "国外で亡くなった場合は、知った日から3か月以内です。"],
    sources: [S.koseki86],
    summary: "死亡届は、死亡の事実を知った日から7日以内に市区町村へ出します。火葬許可の申請と同時に行うのが一般的で、葬儀社が代行することも多い手続きです。",
  },
  {
    id: "setainushi", title: "世帯主の変更届（世帯主だった場合）", cat: "直後", detail: "light",
    when: () => true,
    due: (c) => ({ date: c.death ? addDays(c.death, 13) : null, text: "死亡の日から14日以内（亡くなった方が世帯主で、世帯に2人以上が残る場合）", urgency: "soon" }),
    office: "city",
    action: "亡くなった方が世帯主だったか、残る家族の人数を確認しましょう。",
    sources: [],
    summary: "亡くなった方が世帯主で、世帯に2人以上が残る場合は、市区町村に世帯主の変更を届け出ます。残るのが1人なら不要です。",
  },
  {
    id: "kenkouhoken", title: "健康保険・介護保険の資格喪失と葬祭費の申請", cat: "直後", detail: "light",
    when: () => true,
    due: (c) => ({ date: c.death ? addDays(c.death, 13) : null, text: "資格喪失は死亡の日から14日以内（国民健康保険・後期高齢者医療の場合）。葬祭費は葬儀の翌日から2年以内", urgency: "soon" }),
    office: "city",
    action: "保険証（資格確認書）を返し、あわせて葬祭費を申請しましょう。",
    docs: ["亡くなった方の資格確認書・保険証", "葬儀の領収書など喪主が分かるもの", "振込先の口座"],
    notes: ["会社の健康保険に入っていた場合は、勤務先や健康保険組合が窓口です。", "葬祭費の金額は市区町村ごとに異なります。"],
    sources: [],
    summary: "国民健康保険・後期高齢者医療の資格喪失は死亡の日から14日以内に市区町村へ。葬儀を行った人は葬祭費を申請でき、期限は葬儀の翌日から2年です。",
  },
  {
    id: "nenkin", title: "年金の受給停止と未支給年金の請求", cat: "年金・保険", detail: "light",
    when: (a) => notNo(a.pension),
    due: (c) => ({ date: c.death ? addDays(c.death, 9) : null, text: "受給者死亡届は死亡から10日以内（国民年金のみの方は14日以内）。日本年金機構にマイナンバーが登録されていれば原則不要", urgency: "soon" }),
    office: "nenkin",
    action: "年金を受け取っていたかを確認し、未支給分の請求ができるか年金事務所に問い合わせましょう。",
    notes: ["亡くなった月の分までの年金で、まだ受け取っていない分は、生計を同じくしていた家族が請求できます（未支給年金）。", "遺族年金を受けられる場合もあります。条件は年金事務所で確認できます。"],
    sources: [S.nenkin],
    summary: "年金を受けていた方が亡くなったら、受給を止めます。マイナンバーが登録されていれば届出は原則不要です。まだ受け取っていない年金は、生計を同じくしていた家族が請求できます。",
  },
  {
    id: "hoken", title: "死亡保険金の請求", cat: "年金・保険", detail: "light",
    when: (a) => notNo(a.insurance),
    due: (c) => ({ date: c.death ? addMonths(c.death, 36) : null, text: "請求できる権利は、多くの保険で亡くなった日の翌日から3年で時効（保険法第95条・各社の約款）", urgency: "soon" }),
    office: "insurer",
    action: "保険証券や通帳の引き落としから契約を探し、受取人が保険会社に連絡しましょう。",
    notes: ["死亡保険金のうち「500万円×法定相続人の数」までは相続税がかかりません。", "受取人が決まっている保険金は、遺産分割の対象とは別に扱われるのが原則です。"],
    sources: [S.ta4114],
    summary: "死亡保険金は受取人が保険会社に請求します。多くの保険で、請求の権利は亡くなった日の翌日から3年で時効になります。",
  },
  {
    id: "igon", title: "遺言書を確かめる（検認が必要な場合は家庭裁判所へ）", cat: "相続人と財産の確認", detail: "full",
    when: () => true,
    due: (c) => ({ date: null, text: c.a.will === "y" && c.a.willType === "home" ? "遺言書を見つけたら遅滞なく検認を申し立てる" : "遺産の分け方を決める前に", urgency: "soon" }),
    office: "court",
    action: "自宅の遺言書、公証役場の公正証書遺言、法務局の遺言書保管所の3か所を確認しましょう。",
    docs: ["検認の申立書", "亡くなった方の出生から死亡までの戸籍", "相続人全員の戸籍"],
    notes: [
      "自宅などで見つかった自筆の遺言書は、家庭裁判所で「検認」を受けます。封がしてあるものは、家庭裁判所で開封します。",
      "公正証書遺言と、法務局に保管されていた自筆証書遺言は、検認が要りません。",
      "公正証書遺言があるかは、公証役場で調べられます。法務局の保管制度を使っていたかは、法務局に問い合わせられます。",
      "遺言の有無を確かめずに分け方を決めると、後から遺言が出てきたときに話し合いのやり直しになることがあります。",
    ],
    sources: [S.kennin, S.hokan],
    strong: (a) => a.will === "y" && (a.willType === "home" || a.willType === "u"),
    summary: "遺言書があるかどうかで、分け方の進め方が変わります。自宅で見つかった自筆の遺言書は家庭裁判所で検認を受けます。公正証書遺言と法務局に保管された遺言書は検認が要りません。",
  },
  {
    id: "koseki", title: "戸籍を集めて相続人を確定する", cat: "相続人と財産の確認", detail: "full",
    when: () => true,
    due: () => ({ date: null, text: "早めに（相続放棄を考えるなら3か月の期限までに）", urgency: "soon" }),
    office: "city",
    action: "亡くなった方の出生から死亡までの戸籍を集めましょう。最寄りの市区町村でまとめて請求できます。",
    docs: ["亡くなった方の出生から死亡までの戸籍（除籍・改製原戸籍を含む）", "相続人全員の現在の戸籍", "請求する人の本人確認書類"],
    notes: [
      "2024年3月から、本籍地以外の市区町村の窓口でも戸籍をまとめて請求できます（広域交付）。本人・配偶者・父母や祖父母・子や孫の分に限られ、兄弟姉妹の分は請求できません。",
      "集めた戸籍は、法務局の「法定相続情報証明制度」で一覧図にしてもらうと、銀行や登記など複数の手続きで使い回せます（無料）。",
      "前の結婚の子や認知した子も相続人です。戸籍を最後までそろえて確認しましょう。",
    ],
    sources: [S.kouiki, S.houtei],
    summary: "相続人を確定するには、亡くなった方の出生から死亡までの戸籍を集めます。広域交付を使えば最寄りの窓口でまとめて請求でき、法定相続情報証明制度で一覧図にすると各手続きで使い回せます。",
  },
  {
    id: "zaisan", title: "財産と借金を調べる", cat: "相続人と財産の確認", detail: "light",
    when: () => true,
    due: (c) => ({ date: knownBase(c) ? addMonths(knownBase(c)!, 3) : null, text: "相続放棄の期限（知った日から3か月）までに、借金を含めた全体をつかむ", urgency: "soon" }),
    office: "family",
    action: "通帳・郵便物・固定資産税の通知書から、預貯金・不動産・借金を書き出しましょう。",
    notes: ["不動産は、市区町村の名寄帳や固定資産税の課税明細書で一覧にできます。2026年2月からは、法務局で「所有不動産記録証明書」も請求できます。", "借金は、信用情報機関への開示請求で調べられる場合があります。"],
    sources: [S.toukiQA],
    strong: (a) => a.debt !== "n",
    summary: "相続するか放棄するかを決めるには、預貯金・不動産だけでなく借金も含めた財産の全体をつかむ必要があります。相続放棄の3か月の期限までに調べるのが目安です。",
  },
  {
    id: "houki", title: "相続放棄・限定承認をするか決める", cat: "相続の仕方の判断", detail: "full",
    when: () => true,
    due: (c) => ({ date: knownBase(c) ? addMonths(knownBase(c)!, 3) : null, text: "自分が相続人になったことを知った時から3か月以内", urgency: "soon" }),
    office: "court",
    action: "借金が財産より多そうなら、3か月以内に家庭裁判所へ相続放棄を申し立てるか、専門家に相談しましょう。",
    docs: ["相続放棄の申述書", "亡くなった方の住民票の除票または戸籍の附票", "申し立てる人の戸籍"],
    notes: [
      "何もしないまま3か月が過ぎると、借金も含めてすべて引き継ぐ「単純承認」をしたものとみなされます。",
      "財産の調査が間に合わないときは、3か月の期限内に家庭裁判所へ期間の延長（伸長）を申し立てられます。",
      "限定承認（もらう財産の範囲で借金を返す方法）は、相続人全員が共同で申し立てる必要があります。",
      "遺産を処分したり使ったりすると、相続放棄ができなくなることがあります。",
    ],
    sources: [S.houki, S.enchou, S.gentei],
    strong: (a) => a.debt !== "n",
    summary: "借金を引き継ぎたくない場合は、相続を知った時から3か月以内に家庭裁判所へ相続放棄を申し立てます。間に合わないときは期間の延長を申し立てられます。何もしないと単純承認とみなされます。",
  },
  {
    id: "bunkatsu", title: "遺産の分け方を話し合い、協議書にまとめる", cat: "分け方", detail: "full",
    when: () => true,
    due: (c) => ({ date: knownBase(c) ? addMonths(knownBase(c)!, 10) : null, text: "法律上の期限はないが、相続税の申告（10か月）や相続登記（3年）の前に済ませるのが一般的", urgency: "soon", approx: true }),
    office: "family",
    action: "相続人全員で分け方を決め、遺産分割協議書に全員が署名し実印を押しましょう。",
    docs: ["遺産分割協議書", "相続人全員の印鑑証明書"],
    notes: [
      "話し合いは相続人全員で行います。1人でも欠けると協議は無効です。",
      "分ける前の不動産は相続人全員の共有です。1人の判断で売る・壊す・貸すことはできません。",
      "遺言で分け方がすべて決まっている場合は、協議が要らないこともあります。",
    ],
    sources: [S.touki],
    summary: "遺言で決まっていない財産は、相続人全員の話し合い（遺産分割協議）で分け方を決め、協議書にまとめます。協議書は相続登記や預貯金の手続きで使います。",
  },
  {
    id: "tokubetsudairinin", title: "未成年の子のために特別代理人を選んでもらう", cat: "分け方", detail: "full",
    when: (a) => a.minor === "y",
    due: () => ({ date: null, text: "遺産分割の話し合いの前に（審理には1か月ほどかかることがある）", urgency: "soon" }),
    office: "court-child",
    action: "親と未成年の子がともに相続人なら、子の住所地の家庭裁判所に特別代理人の選任を申し立てましょう。",
    docs: ["申立書", "子と親の戸籍", "特別代理人候補者の住民票", "遺産分割協議書の案"],
    notes: ["親と未成年の子が一緒に相続人になると、親は子の代理として話し合いに加われません（利益相反）。", "候補者には、相続に利害関係のない人（叔父・叔母など）を立てるのが一般的です。"],
    sources: [S.tokudai],
    strong: () => true,
    summary: "親と未成年の子がともに相続人の場合、親は子の代理として遺産分割の話し合いに加われません。子の住所地の家庭裁判所に、特別代理人の選任を申し立てます。",
  },
  {
    id: "junkakutei", title: "準確定申告（亡くなった方の所得税の申告）", cat: "税金", detail: "light",
    when: () => true,
    due: (c) => ({ date: knownBase(c) ? addMonths(knownBase(c)!, 4) : null, text: "相続の開始を知った日の翌日から4か月以内（申告が必要な場合）", urgency: "soon" }),
    office: "tax",
    action: "亡くなった方に年金以外の所得や、事業・不動産の収入があったか確認しましょう。",
    notes: ["収入が年金だけだった場合など、申告が要らないこともあります。医療費が多かった年は、申告で税金が戻ることもあります。"],
    sources: [S.junkaku],
    summary: "亡くなった年の1月1日から亡くなった日までの所得について、相続人が代わりに所得税を申告します。期限は相続の開始を知った日の翌日から4か月以内です。",
  },
  {
    id: "souzokuzei", title: "相続税の申告が要るか確かめる", cat: "税金", detail: "full",
    when: () => true,
    due: (c) => ({ date: knownBase(c) ? addMonths(knownBase(c)!, 10) : null, text: "申告が必要な場合は、相続の開始を知った日の翌日から10か月以内", urgency: "soon" }),
    office: "tax",
    action: "遺産の合計を、基礎控除（3,000万円＋600万円×法定相続人の数）と比べましょう。",
    notes: ["期限を過ぎると延滞税や加算税がかかり、期限内の申告が条件の特例が使えなくなることがあります。"],
    sources: [S.ta4152, S.ta4205, S.ta4114, S.ta4124],
    summary: "遺産の合計が基礎控除（3,000万円＋600万円×法定相続人の数）以下なら、相続税の申告は要りません。超える場合は、相続の開始を知った日の翌日から10か月以内に申告します。",
  },
  {
    id: "souzokutouki", title: "相続登記（不動産の名義変更）", cat: "名義変更", detail: "full",
    when: () => true,
    due: (c) => {
      const k = knownBase(c);
      if (!k) return { date: null, text: "相続で取得したことを知った日から3年以内（2024年4月より前に知った相続は2027年3月31日まで）", urgency: "later" };
      if (k < KNOWN_BEFORE_2024) return { date: new Date(2027, 2, 31), text: "2024年4月1日より前に知った相続は、2027年3月31日まで", urgency: "later" };
      return { date: addMonths(k, 36), text: "相続で取得したことを知った日から3年以内", urgency: "later" };
    },
    office: "moj",
    action: "登記簿で今の名義を確認し、分け方が決まったら管轄の法務局に申請しましょう。",
    docs: ["登記申請書", "戸籍一式（または法定相続情報一覧図）", "遺産分割協議書と印鑑証明書", "不動産を取得する人の住民票", "固定資産評価証明書"],
    notes: [
      "2024年4月から義務になり、正当な理由なく申請しないと10万円以下の過料の対象になります。",
      "分け方の話し合いが期限に間に合わないときは、自分が相続人であることを申し出る「相続人申告登記」で義務を果たせます（登録免許税はかかりません）。ただし売却などには、別に相続登記が要ります。",
      "名義が祖父母など前の代のままの土地は、相続人が多くなり手続きが複雑になりがちです。早めに司法書士に相談するのが安全です。",
    ],
    sources: [S.touki, S.toukiQA, S.shinkoku],
    strong: (a) => a.title !== "y",
    summary: "不動産を相続したら、取得を知った日から3年以内に管轄の法務局へ相続登記を申請します（2024年4月より前に知った相続は2027年3月31日まで）。間に合わないときは相続人申告登記で義務を果たせます。",
  },
  {
    id: "koteishisanzei", title: "固定資産税の「現に所有している人」の申告", cat: "名義変更", detail: "full",
    when: () => true,
    due: () => ({ date: null, text: "市区町村の条例で定める期限まで（通知が届いたら早めに）。相続登記を済ませた場合は不要", urgency: "soon" }),
    office: "city",
    action: "不動産のある市区町村から届く案内に沿って、相続人の代表者などを申告しましょう。",
    notes: ["登記の名義人が亡くなった後、相続登記が済むまでの間は、実際に所有している相続人が固定資産税を納めます。市区町村はその人の氏名・住所などの申告を求めることができます。", "相続放棄をした人は申告の必要がありません。"],
    sources: [S.koteishisan],
    summary: "登記の名義人が亡くなり相続登記がまだのとき、不動産のある市区町村は、実際に所有している相続人に氏名・住所などの申告を求めます。相続登記を済ませれば不要です。",
  },
  {
    id: "yokin", title: "預貯金・証券口座の解約や名義変更", cat: "名義変更", detail: "light",
    when: (a) => notNo(a.bank),
    due: () => ({ date: null, text: "分け方が決まってから（それまで口座は凍結されることがある）", urgency: "later" }),
    office: "bank",
    action: "各金融機関に亡くなったことを伝え、相続手続きの書類を取り寄せましょう。",
    notes: ["分け方が決まる前でも、預貯金の一部を払い戻せる制度があります。金額には上限があります。", "法定相続情報一覧図があると、戸籍の束を出し直さずに済みます。"],
    sources: [S.houtei],
    summary: "預貯金や証券口座は、金融機関ごとに解約や名義変更の手続きをします。分け方が決まってからが一般的で、法定相続情報一覧図があると手続きが楽になります。",
  },
  {
    id: "nouchi", title: "農地を相続したときの農業委員会への届出", cat: "土地の届出", detail: "full",
    when: (a) => has(a, "farm"),
    due: (c) => ({ date: knownBase(c) ? addMonths(knownBase(c)!, 10) : null, text: "権利を取得したことを知った後、遅滞なく（おおむね10か月以内）", urgency: "soon", approx: true }),
    office: "farm",
    action: "農地のある市町村の農業委員会に、相続で農地を取得したことを届け出ましょう。",
    notes: ["相続登記とは別の届出です。届け出ないと10万円以下の過料の対象になります。", "耕作を続けられない場合は、農業委員会に貸し出しなどを相談できます。"],
    sources: [S.nouchi],
    summary: "田や畑を相続したら、農地のある市町村の農業委員会に届け出ます（農地法第3条の3）。相続登記とは別の手続きで、おおむね10か月以内が目安です。",
  },
  {
    id: "shinrin", title: "森林を相続したときの市町村への届出", cat: "土地の届出", detail: "full",
    when: (a) => has(a, "forest"),
    due: (c) => ({ date: c.death ? addDays(c.death, 89) : null, text: "土地の所有者になった日（相続では亡くなった日）から90日以内。遺産分割の前でも必要", urgency: "soon" }),
    office: "forest",
    action: "森林のある市町村に「森林の土地の所有者届出」を出しましょう。",
    notes: ["相続登記とは別の届出です。届け出ないと10万円以下の過料の対象になります。", "分け方が決まっていなくても、相続人の共有として届け出ます。"],
    sources: [S.shinrin],
    summary: "山林を相続したら、亡くなった日から90日以内に、森林のある市町村へ所有者の届出をします。遺産分割が済む前でも必要で、相続登記とは別の手続きです。",
  },
];

// ---------- 問い3：大きな失敗をしないために ----------
export interface Caution {
  id: string;
  title: string; // 「大きな失敗をしないために、〜をお勧めします」の「〜」
  why: string;
  when: (a: Answers) => boolean;
  strong?: (a: Answers) => boolean;
  sources: Source[];
}

export const CAUTIONS: Caution[] = [
  {
    id: "kigen-houki", title: "借金の有無を確かめ、相続放棄をするかを3か月以内に決めることをお勧めします",
    why: "何もしないまま3か月が過ぎると、借金も含めてすべてを引き継いだものとみなされます。調査が間に合わないときは、期限内に家庭裁判所へ延長を申し立てられます。",
    when: () => true, strong: (a) => a.debt !== "n", sources: [S.houki, S.enchou],
  },
  {
    id: "tetsukezu", title: "借金があるか分からないうちは、遺産を使ったり処分したりしないことをお勧めします",
    why: "預貯金を引き出して使う、家財を売る、亡くなった方の借金を一部だけ返す、といった行為は、相続を受け入れたとみなされ、相続放棄ができなくなることがあります。",
    when: (a) => a.debt !== "n", strong: (a) => a.debt !== "n", sources: [S.houki],
  },
  {
    id: "kennin", title: "自筆の遺言書は開封せず、家庭裁判所で検認を受けることをお勧めします",
    why: "封のある遺言書は家庭裁判所で開封します。検認の前に開封すると過料の対象になることがあります。",
    when: (a) => a.will === "y" && (a.willType === "home" || a.willType === "u"), strong: () => true, sources: [S.kennin],
  },
  {
    id: "igon-kakunin", title: "分け方を決める前に、遺言書の有無を3か所で確かめることをお勧めします",
    why: "後から遺言書が見つかると、話し合いのやり直しになることがあります。自宅・公証役場・法務局の遺言書保管所を確認しましょう。",
    when: (a) => a.will !== "y", sources: [S.hokan],
  },
  {
    id: "koseki-saigo", title: "戸籍を出生から死亡まで最後までそろえ、相続人を確定させることをお勧めします",
    why: "前の結婚の子や認知した子を見落としたまま話し合うと、協議が無効になります。",
    when: () => true, sources: [S.kouiki],
  },
  {
    id: "zenin", title: "不動産の売却・解体・賃貸は、相続人全員で合意してから進めることをお勧めします",
    why: "分ける前の不動産は相続人全員の共有です。1人の判断で売る・壊す・貸すことはできず、進めても無効や争いの元になります。家財の処分や預貯金の引き出しも、ほかの相続人に知らせてから行いましょう。",
    when: () => true, sources: [S.touki],
  },
  {
    id: "shomen", title: "分け方の合意は、遺産分割協議書として書面に残すことをお勧めします",
    why: "口約束は後で覆りやすく、相続登記や預貯金の手続きにも使えません。",
    when: () => true, sources: [S.touki],
  },
  {
    id: "touki-hayaku", title: "相続登記は先延ばしにせず、分け方が決まったら早めに申請することをお勧めします",
    why: "期限を過ぎると過料の対象になるうえ、次の相続が重なると相続人が増え、話し合いがまとまりにくくなります。",
    when: () => true, strong: (a) => a.title !== "y", sources: [S.touki],
  },
  {
    id: "zeikin-jikohandan", title: "相続税の申告が要らないかは、特例を使う前の額で確かめることをお勧めします",
    why: "小規模宅地等の特例を使ってはじめて基礎控除以下になる場合も、申告が必要です。期限の10か月を過ぎると、延滞税などのほか特例が使えなくなることがあります。",
    when: () => true, sources: [S.ta4205, S.ta4124],
  },
  {
    id: "akiya", title: "誰も住まない家は、定期的に見回るか管理を頼み、放置しないことをお勧めします",
    why: "管理が行き届かず市区町村から勧告を受けると、固定資産税の住宅用地特例（税の軽減）が外れます。倒壊や害虫などで近隣に損害が出たときの責任も残ります。",
    when: (a) => a.vacant !== "n" && has(a, "home"), sources: [S.akiya],
  },
  {
    id: "houmon-kaitori", title: "「今すぐ高く買う」と訪問や電話で急かされても、その場で契約しないことをお勧めします",
    why: "相続の直後は判断が鈍りやすく、押し買いの標的になりがちです。自宅の売却にはクーリング・オフが効きません。困ったときは消費者ホットライン（188）に相談できます。",
    when: () => true, sources: [S.kokusen1],
  },
  {
    id: "aimitsumori", title: "売却・解体・遺品整理・管理は、1社で決めず複数社の見積りを比べることをお勧めします",
    why: "見積りを取らずに頼むと、作業後に高額を請求されることがあります。複数社を比べると相場が分かり、「今決めないと損」と急かされても落ち着いて判断できます。",
    when: () => true, sources: [S.kokusen1],
  },
  {
    id: "genya", title: "山林や原野に「買い手がいる」と言われても、手数料や測量費を先に払わないことをお勧めします",
    why: "相続した山林・原野を狙った「原野商法の二次被害」が続いています。消費者ホットライン（188）に相談できます。",
    when: (a) => has(a, "forest") || has(a, "farm") || has(a, "land"), sources: [S.kokusen2],
  },
  {
    id: "mushikaku", title: "手続きの代行は、司法書士・税理士・弁護士などの資格者に頼むことをお勧めします",
    why: "登記の申請代理や税務申告の作成、相続人同士の交渉の代理は資格者の業務です。資格のない「代行業者」には頼まないようにしましょう。",
    when: () => true, sources: [],
  },
  {
    id: "zendai", title: "名義が祖父母など前の代のままなら、早めに司法書士へ相談することをお勧めします",
    why: "前の代の相続も合わせて手続きすることになり、相続人の数が増えて書類も複雑になります。",
    when: (a) => a.title !== "y", strong: (a) => a.title === "n", sources: [S.toukiQA],
  },
];

// ---------- 問い2：選べること ----------
export interface Choice {
  id: string;
  group: "仕方" | "土地";
  title: string;
  fit: string; // 向いている条件
  next: string; // 次の一手
  care: string; // 注意点
  link?: { label: string; href: string };
}

export const CHOICES: Choice[] = [
  { id: "shoukei", group: "仕方", title: "そのまま相続する（単純承認）", fit: "財産が借金より明らかに多いとき", next: "分け方を話し合い、名義変更へ進みます。", care: "3か月が過ぎると、この形になったものとみなされます。" },
  { id: "houki", group: "仕方", title: "相続放棄をする", fit: "借金が財産より多いとき、相続に関わりたくないとき", next: "3か月以内に家庭裁判所へ申し立てます。", care: "放棄すると最初から相続人でなかった扱いになり、次の順位の親族が相続人になります。" },
  { id: "gentei", group: "仕方", title: "限定承認をする", fit: "借金がどれだけあるか分からないとき", next: "3か月以内に、相続人全員で家庭裁判所へ申し立てます。", care: "手続きが重く、専門家の手を借りるのが一般的です。" },
  { id: "sumu", group: "土地", title: "住む・建て替える", fit: "家族の誰かが住む予定があるとき", next: "建てられる規模を確かめてから間取りへ。", care: "建て替えには相続登記を済ませておく必要があります。", link: { label: "相続した土地で3案を見る", href: "/new?s=inherit" } },
  { id: "uru", group: "土地", title: "売る", fit: "住む予定がなく、管理の手間を減らしたいとき", next: "複数社の査定を並べて価格の幅を見ます。", care: "売る前に相続登記が必要です。1社の言い値で決めないようにしましょう。", link: { label: "売却のガイド", href: "/guide/sell" } },
  { id: "kasu", group: "土地", title: "貸す・活用する", fit: "立地に需要があり、長く持つつもりのとき", next: "賃貸・駐車場など、複数社の活用プランを比べます。", care: "借入れを伴う計画は、収支の前提を自分で確かめましょう。", link: { label: "土地活用のガイド", href: "/guide/land-use" } },
  { id: "kokko", group: "土地", title: "国に引き取ってもらう（相続土地国庫帰属制度）", fit: "売れず、使う予定もない土地", next: "法務局に事前相談し、要件を確かめます。", care: "建物がある土地は対象外で、審査手数料と10年分の管理費相当額の負担金がかかります。", link: { label: "法務省の案内", href: "https://www.moj.go.jp/MINJI/minji05_00457.html" } },
  { id: "hoyuu", group: "土地", title: "管理しながら決めるのを待つ", fit: "家族の考えがまだまとまらないとき", next: "相続登記だけは期限内に済ませておきます。", care: "空き家は放置すると税の軽減が外れることがあります。見回りか管理の依頼を。", link: { label: "空き家のガイド", href: "/guide/akiya" } },
];

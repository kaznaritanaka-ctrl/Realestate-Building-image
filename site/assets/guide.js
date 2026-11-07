// ガイドページの閲覧記録：src/track.ts と同じ仮名セッションIDで guide_view を送る（個人を特定する情報・位置は送らない）
(function () {
  var sid;
  try {
    sid = sessionStorage.getItem("tm-sid");
    if (!sid) {
      var b = new Uint8Array(8);
      crypto.getRandomValues(b);
      sid = Array.from(b, function (x) { return x.toString(16).padStart(2, "0"); }).join("");
      sessionStorage.setItem("tm-sid", sid);
    }
  } catch (e) { sid = "0000000000000000"; }
  var body = JSON.stringify({
    sid: sid,
    name: "guide_view",
    props: {
      page: location.pathname.replace(/^\//, "").replace(/\.html$/, ""),
      mobile: window.matchMedia("(max-width: 640px)").matches
    }
  });
  try {
    if (navigator.sendBeacon) navigator.sendBeacon("/api/event", new Blob([body], { type: "application/json" }));
    else fetch("/api/event", { method: "POST", body: body, keepalive: true, headers: { "content-type": "application/json" } }).catch(function () {});
  } catch (e) { /* 計測の失敗は無視 */ }
})();

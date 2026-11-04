import { track } from "./track.ts";
let ref = "";
try { ref = document.referrer ? new URL(document.referrer).hostname : ""; } catch { /* noop */ }
track("lp_view", { ref: ref || "direct", mobile: matchMedia("(max-width: 760px)").matches });

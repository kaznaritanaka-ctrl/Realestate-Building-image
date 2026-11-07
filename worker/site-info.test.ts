import { test } from "node:test";
import assert from "node:assert/strict";
import { siteInfo } from "./site-info.ts";

test("位置データの追加レイヤーを取り込み、商用制約のある土砂APIは照会しない", async () => {
  const seen: string[] = [];
  const around: [number,number][][] = [[[135.49,34.69],[135.51,34.69],[135.51,34.71],[135.49,34.71],[135.49,34.69]]];
  const fetchJson = async (url: string) => {
    seen.push(url);
    if(url.includes("XKT029")) throw new Error("restricted");
    const props = url.includes("XKT003") ? {kubun_name_ja:"居住誘導区域"} : 
      url.includes("XKT027") ? {A49_003:"0.5m未満"} : null;
    if(props) return {status:200,body:{features:[{geometry:{type:"Polygon",coordinates:around},properties:props}]}};
    if(url.includes("XST001")) return {status:200,body:{features:[{geometry:{type:"Point",coordinates:[135.5002,34.7002]},properties:{disaster_name_ja:"浸水域"}}]}};
    return {status:200,body:{features:[]}};
  };
  const out = await siteInfo(34.7,135.5,fetchJson);
  assert.equal((out.XKT003 as {found:number}).found,1);
  assert.equal((out.XKT027 as {found:number}).found,1);
  assert.equal((out.XST001 as {found:number}).found,1);
  assert.equal((out.XKT029 as {error:string}).error,"license_review_required");
  assert.ok(!seen.some(u=>u.includes("XKT029")));
});

// Engine tests for Ad Performance Copilot.
// Run: node ad-copilot.test.js            (expects ad-copilot.html in the same folder)
//      node ad-copilot.test.js path/to/ad-copilot.html
const fs=require("fs"),path=require("path"),vm=require("vm"),assert=require("assert");
const file=process.argv[2]||path.join(__dirname,"ad-copilot.html");
const html=fs.readFileSync(file,"utf8");
const src=html.slice(html.indexOf("// ===== ENGINE START"),html.indexOf("// ===== ENGINE END"));
const ctx={module:{exports:{}}};vm.createContext(ctx);vm.runInContext(src,ctx);const E=ctx.module.exports;

let pass=0,fail=0;
function test(name,fn){try{fn();pass++;console.log("  ✓",name)}catch(e){fail++;console.log("  ✗",name,"\n     ",e.message)}}
const F={m:v=>v==null?"–":"$"+v.toFixed(2),n:v=>String(Math.round(v)),a:v=>Math.round(Math.abs(v)*100)+"%",x:v=>v.toFixed(2)+"×"};
function load(sheets){return sheets.map(([name,rows],i)=>{const h=E.findHeaderRow(rows),headers=rows[h].map(String),body=rows.slice(h+1);body.headers=headers;const map=E.autoMap(headers);
  return{id:"f"+i,name,map,role:map.spend==null&&map.conv!=null?"conv":"spend",hasRev:map.revenue!=null,detail:["adset","ad","geo","os"].filter(k=>map[k]!=null).length,rows:E.toRows(body,map,E.detectChannel(headers,name),"f"+i)}})}

console.log("Parsing");
test("Google Ads headers map to the right fields",()=>{const m=E.autoMap(["Campaign","Day","Cost","Impr.","Clicks","Conversions","Conv. value","Avg. CPC"]);
  assert.deepStrictEqual([m.campaign,m.date,m.spend,m.impressions,m.clicks,m.conv,m.revenue],[0,1,2,3,4,5,6])});
test("Meta headers map, incl. link clicks over clicks (all)",()=>{const m=E.autoMap(["Campaign name","Ad set name","Reporting starts","Amount spent (USD)","Clicks (all)","Link clicks","Results","Frequency"]);
  assert.strictEqual(m.clicks,5);assert.strictEqual(m.spend,3);assert.strictEqual(m.adset,1);assert.strictEqual(m.frequency,7)});
test("AppsFlyer-style file: media source is channel, platform is OS, no spend",()=>{const m=E.autoMap(["Media source","Campaign","Date","Platform","Installs"]);
  assert.strictEqual(m.channel,0);assert.strictEqual(m.os,3);assert.strictEqual(m.spend,undefined)});
test("numbers in US and EU formats",()=>{assert.strictEqual(E.num("1,234.56"),1234.56);assert.strictEqual(E.num("1.234,56"),1234.56);assert.strictEqual(E.num("$ 12"),12);assert.strictEqual(E.num("(5.00)"),-5);assert.strictEqual(E.num("--"),0)});
test("dates: ISO, day-first, Excel serial",()=>{assert.strictEqual(E.parseDate("2026-10-05"),"2026-10-05");assert.strictEqual(E.parseDate("05/10/2026","dmy"),"2026-10-05");assert.strictEqual(E.parseDate(46000),"2025-12-09")});
test("country and OS read from campaign names",()=>{assert.strictEqual(E.nameGeo("App – iOS – US – tCPA"),"US");assert.strictEqual(E.nameOs("App – iOS – US"),"iOS");
  assert.strictEqual(E.nameGeo("In-Feed – Broad"),null);assert.strictEqual(E.nameGeo("Search United States"),"US");assert.strictEqual(E.osVal("Mobile phones"),"Mobile");assert.strictEqual(E.osVal("instagram"),null)});
test("CSV with quotes and semicolons",()=>{const r=JSON.parse(JSON.stringify(E.parseCSV('a;b\n"x;1";2\n')));assert.deepStrictEqual(r,[["a","b"],["x;1","2"]])});

console.log("Combining files");
const S=E.sample();
test("overlapping re-export is counted once (newer file wins)",()=>{const res=E.combine(load(S));
  assert.strictEqual(res.stats.f0.dropped,50);assert.strictEqual(res.stats.f3.used,50);assert.strictEqual(res.rows.length,420)});
test("totals equal a single copy of the data",()=>{const once=E.agg(E.combine(load(S.slice(0,3))).rows),twice=E.agg(E.combine(load(S)).rows);assert.ok(Math.abs(once.spend-twice.spend)<1e-6)});
test("more detailed file wins over a less detailed one",()=>{const a=[["Campaign","Day","Cost","Conversions"],["X – US","2026-10-01","100","10"]],b=[["Campaign","Day","Country","Cost","Conversions"],["X – US","2026-10-01","US","60","6"],["X – US","2026-10-01","CA","40","4"]];
  const res=E.combine(load([["detail google.csv",b],["plain google.csv",a]]));assert.strictEqual(res.rows.length,2);assert.strictEqual(E.agg(res.rows).spend,100)});
test("conversions file replaces platform conversions on matching campaigns",()=>{const sp=[["Campaign","Day","Cost","Conversions"],["Alpha","2026-10-01","100","50"],["Beta","2026-10-01","100","40"]],
  cv=[["Media source","Campaign","Date","Installs"],["googleadwords_int","Alpha","2026-10-01","30"],["googleadwords_int","Gamma","2026-10-01","9"]];
  const res=E.combine(load([["google.csv",sp],["af.csv",cv]])),a=res.rows.find(r=>r.campaign==="Alpha"),b=res.rows.find(r=>r.campaign==="Beta");
  assert.strictEqual(a.conv,30);assert.strictEqual(a.platConv,50);assert.strictEqual(b.conv,40);assert.strictEqual(res.stats.f1.unmatched,1)});

console.log("Takeaways");
const rows=E.combine(load(S)).rows,opt={range:7,target:0,targetAuto:true,convName:"Installs",f:F};
const ins=E.insights(rows,opt);
test("returns 3 to 5 takeaways with unique ids",()=>{assert.ok(ins.length>=3&&ins.length<=5,`got ${ins.length}`);assert.strictEqual(new Set(ins.map(i=>i.id)).size,ins.length)});
test("one takeaway per campaign at most",()=>{const k=ins.filter(i=>i.key).map(i=>i.key);assert.strictEqual(new Set(k).size,k.length)});
test("finds the creative fatigue in the sample",()=>assert.ok(ins.some(i=>/Refresh creatives in Prospecting – iOS – US/.test(i.title))));
test("finds a segment pattern",()=>assert.ok(ins.some(i=>i.type==="pattern")));
test("every takeaway explains itself (why) and most can focus the dashboard",()=>{assert.ok(ins.every(i=>!i.why||i.why.length>0));assert.ok(ins.filter(i=>i.focus).length>=3)});
test("excluded (done/dismissed) takeaways are replaced",()=>{const ex=new Set([ins[0].id]),ins2=E.insights(rows,{...opt,exclude:ex});assert.ok(!ins2.some(i=>i.id===ins[0].id));assert.ok(ins2.length>=3)});
test("stricter pause threshold gives fewer pauses",()=>{const all={...opt,th:{pause:1.3}},strict={...opt,th:{pause:3}};
  const c=o=>E.insights(rows,o).filter(i=>i.type==="pause").length;assert.ok(c(strict)<=c(all))});
test("low-volume campaign is not judged on a lucky CPA",()=>{const sp=[["Campaign","Day","Cost","Conversions"]];
  for(let d=1;d<=9;d++){sp.push(["Big A",`2026-10-0${d}`,"1000","400"]);sp.push(["Big B",`2026-10-0${d}`,"1000","350"])}
  sp.push(["Tiny","2026-10-09","40","2"]);const r=E.combine(load([["google.csv",sp]])).rows,i=E.insights(r,{...opt,range:0});assert.ok(!i.some(x=>x.type==="scale"&&/Tiny/.test(x.title)))});
test("no conversions gives a clear message",()=>{const sp=[["Campaign","Day","Cost","Clicks"],["A","2026-10-01","100","5"]];const i=E.insights(E.combine(load([["google.csv",sp]])).rows,{...opt,range:0});assert.strictEqual(i[0].id,"noconv")});

console.log("What-if and heatmap");
test("applying the moves lowers CPA",()=>{const s=E.simulate(rows,opt,ins);assert.ok(s.moves>0);assert.ok(s.after.cpa<s.before.cpa,`${s.after.cpa} vs ${s.before.cpa}`)});
test("pausing a campaign removes its spend",()=>{const g=E.breakdown(rows,"campaign",E.periods(rows,7))[0],s=E.simulate(rows,opt,[{act:{kind:"group",key:g.key,factor:0}}]);assert.ok(Math.abs(s.before.spend-s.after.spend-g.spend)<1e-6)});
test("heatmap cells add up to the rows that have both dimensions",()=>{const h=E.heatmap(rows,7,"channel+os","geo");let s=0;h.rows.forEach(a=>h.cols.forEach(b=>{const c=h.cell(a,b);if(c)s+=c.spend}));
  const per=E.periods(rows,7),want=E.agg(rows.filter(r=>E.inR(r,per.cur)&&r.os&&r.geo)).spend;assert.ok(Math.abs(s-want)<1e-6)});
test("focus filters match the heatmap filter",()=>{const h=E.heatmap(rows,7,"channel+os","geo"),f=h.filter(h.rows[0],h.cols[0]),p=E.focusPred({kind:"seg",f});assert.ok(rows.some(p))});

console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);

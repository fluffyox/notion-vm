const NFE = require("../src/engine.js");
const ctx = { values: [], rowPointer:{table:'block',id:'r1'}, userTimeZone:'Asia/Tokyo', intl:{locale:'zh'}, __label:'main' };
const bc = NFE.compile(NFE.parse("sum(map([1,2], current * 10))"));
NFE.resetRT();
const gen = NFE.F(bc, ctx);
let injected, n=0;
for(;;){
  const {value:ev, done} = injected===undefined?gen.next():gen.next(injected); injected=undefined;
  if(done){ console.log("RESULT", NFE.shortBox(ev)); break; }
  if(ev.t==='step'){
    const f = ev.frame;
    console.log(String(n++).padStart(2), "depth="+NFE.RT.frames.length, "ip="+ev.ip,
      "| "+ev.instr.asm.padEnd(34),
      "| stack:["+f.stack.snapshot().map(NFE.shortBox).join(" ")+"]",
      "| frames:["+NFE.RT.frames.map(x=>x.label).join(" › ")+"]");
  } else if(ev.t==='fetch'){ injected = null; }
  if(n>80) {console.log("...");break;}
}

// synthetic M1 generator: piecewise-linear waypoints [minute, price] + deterministic noise
function rng(s){return function(){s|=0;s=s+0x6D2B79F5|0;let t=Math.imul(s^s>>>15,1|s);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function gen(t0,wp,noise,seed){const R=rng(seed||7),rows=[];const end=wp[wp.length-1][0];
 const px=m=>{for(let i=1;i<wp.length;i++){if(m<=wp[i][0]){const [m0,p0]=wp[i-1],[m1,p1]=wp[i];return p0+(p1-p0)*(m-m0)/Math.max(1,m1-m0)}}return wp[wp.length-1][1]};
 for(let m=0;m<=end;m++){const base=px(m);const ticks=[];for(let k=0;k<6;k++){ticks.push(px(m+k/6)+(R()-0.5)*2*noise)}
  const o=ticks[0],c=ticks[5],h=Math.max(...ticks),l=Math.min(...ticks);rows.push([t0+m*60,+o.toFixed(2),+h.toFixed(2),+l.toFixed(2),+c.toFixed(2),6])}
 return rows}
module.exports={gen};

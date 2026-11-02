const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// Three-way merge by stable identity. Overlapping edits require an explicit choice.
export function mergeProjectPlans(base,mine,theirs,choices={}){
  const conflicts=[];
  function merge(b,m,t,path){
    if(same(m,t))return structuredClone(m);
    if(same(m,b))return structuredClone(t);
    if(same(t,b))return structuredClone(m);
    if(object(m)&&object(t)&&(object(b)||b===undefined)){
      const result={};for(const key of new Set([...Object.keys(b??{}),...Object.keys(m),...Object.keys(t)])){const value=merge(b?.[key],m[key],t[key],path.concat(key));if(value!==undefined)result[key]=value;}return result;
    }
    const keyed=x=>Array.isArray(x)&&x.every(v=>object(v)&&typeof v.id==='string');
    if(keyed(m)&&keyed(t)&&(keyed(b)||b===undefined)){
      const maps=[b??[],m,t].map(a=>new Map(a.map(v=>[v.id,v]))),result=[];
      for(const id of new Set([...maps[1].keys(),...maps[2].keys(),...maps[0].keys()])){const value=merge(...maps.map(x=>x.get(id)),path.concat(id));if(value!==undefined)result.push(value);}return result;
    }
    const key=JSON.stringify(path),choice=choices[key];if(!choice)conflicts.push({key,path,mine:m,theirs:t});
    return structuredClone(choice==='theirs'?t:m);
  }
  return {plan:merge(base,mine,theirs,[]),conflicts};
}

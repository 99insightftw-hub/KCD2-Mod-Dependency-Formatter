'use strict';
// Ownership is decided for declared write targets, never by a global manager flag.
const fs=require('fs/promises'),path=require('path');
const {execFile}=require('child_process'),{promisify}=require('util');
const {safeRelative,hash}=require('./io');
const run=promisify(execFile),MAX_MANIFEST=20*1024*1024;
const key=p=>path.resolve(p).toLowerCase();
const within=(base,file)=>key(base)===key(file)||key(file).startsWith(key(base)+path.sep);
const exists=async p=>fs.lstat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
function normalizeScope(game,scope) {
  if(!scope||!Array.isArray(scope.subtrees)||!Array.isArray(scope.files)||!scope.subtrees.length&&!scope.files.length)throw Error('An explicit nonempty ownership scope is required.');
  const result={subtrees:scope.subtrees.map(p=>path.resolve(p)),files:scope.files.map(p=>path.resolve(p))};
  if([...result.subtrees,...result.files].some(p=>!within(game.root,p)||key(p)===key(game.root))||result.subtrees.some(p=>key(p)===key(game.mods)))throw Error('Manual ownership scope must stay inside exact declared targets in the selected game.');
  return result;
}
function affected(scope,file) {
  return scope.subtrees.some(root=>within(root,file)||within(file,root))||scope.files.some(target=>key(target)===key(file)||within(file,target));
}
async function plainAncestors(target) {
  let cursor=path.resolve(target);
  for(;;){const s=await exists(cursor);if(s&&(s.isSymbolicLink()||s.isFile()&&s.nlink>1))throw Error('Manual target is linked or shared: '+cursor);const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}
}
// JSON.parse accepts duplicate keys. An ownership ledger must have one meaning.
function parseLedger(text) {
  const value=JSON.parse(text);let offset=0;
  function whitespace(){while(/\s/.test(text[offset]||'')&&offset<text.length)offset++;}
  function string(){const start=offset++;while(offset<text.length){const ch=text[offset++];if(ch==='\\')offset++;else if(ch==='"')return JSON.parse(text.slice(start,offset));}throw Error('Unterminated deployment string');}
  function walk(depth=0){
    if(depth>64)throw Error('Deployment manifest nesting limit reached');whitespace();
    if(text[offset]==='{'){
      offset++;whitespace();const keys=new Set();if(text[offset]==='}'){offset++;return;}
      for(;;){whitespace();const name=string();if(keys.has(name))throw Error('Ambiguous duplicate deployment field: '+name);keys.add(name);whitespace();offset++;walk(depth+1);whitespace();if(text[offset++]==='}')return;}
    }
    if(text[offset]==='['){offset++;whitespace();if(text[offset]===']'){offset++;return;}for(;;){walk(depth+1);whitespace();if(text[offset++]===']')return;}}
    if(text[offset]==='"'){string();return;}while(offset<text.length&&!/[\s,}\]]/.test(text[offset]))offset++;
  }
  walk();return value;
}
async function vortexRunning() {
  if(process.platform!=='win32')return false;
  const {stdout}=await run('tasklist.exe',['/FI','IMAGENAME eq Vortex.exe','/FO','CSV','/NH'],{windowsHide:true,timeout:5000});
  return /^"Vortex\.exe"/im.test(stdout);
}
async function assertUnmarkedAncestors(game,target) {
  let cursor=path.resolve(target);
  const st=await exists(cursor);if(!st?.isDirectory())cursor=path.dirname(cursor);
  while(within(game.root,cursor)){
    if(await exists(path.join(cursor,'__folder_managed_by_vortex')))throw Error('Vortex folder marker owns this target: '+cursor+'. Deploy or repair it through Vortex.');
    if(key(cursor)===key(game.root))break;cursor=path.dirname(cursor);
  }
}
async function assertManualScope(game,declared,{running=vortexRunning}={}) {
  const scope=normalizeScope(game,declared),manifests=[];
  for(const target of [...scope.subtrees,...scope.files]){await plainAncestors(target);await assertUnmarkedAncestors(game,target);}
  for(const dir of [...new Set([game.root,game.mods,game.bin].map(p=>path.resolve(p)))]) {
    await plainAncestors(dir);
    const names=await fs.readdir(dir).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    for(const name of names.filter(n=>/^vortex\.deployment(?:\..*)?\.json$/i.test(n))) {
      const file=path.join(dir,name);
      try {
        await plainAncestors(file);const st=await fs.lstat(file);
        if(!st.isFile()||st.size>MAX_MANIFEST)throw Error('Deployment ledger is not a bounded regular file');
        const bytes=await fs.readFile(file),text=bytes.toString('utf8').replace(/^\uFEFF/,'');
        if(!Buffer.from(bytes.toString('utf8')).equals(bytes))throw Error('Deployment ledger is not UTF-8');
        const m=parseLedger(text);
        if(!m||typeof m!=='object'||Array.isArray(m)||m.version!==undefined&&m.version!==1||!Array.isArray(m.files)||m.files.length>100000)throw Error('Unsupported deployment manifest');
        if(m.gameId!==undefined&&m.gameId!=='kingdomcomedeliverance2')throw Error('Deployment game identity is ambiguous');
        if(m.targetPath!==undefined&&(typeof m.targetPath!=='string'||!m.targetPath||!path.isAbsolute(m.targetPath)))throw Error('Deployment target must be an absolute folder');
        const target=path.resolve(m.targetPath||dir);
        if(!within(game.root,target))throw Error('Deployment target belongs to another installation');
        const seen=new Set();
        for(const entry of m.files) {
          if(!entry||typeof entry!=='object'||Array.isArray(entry)||typeof entry.relPath!=='string'||entry.target!==undefined&&typeof entry.target!=='string')throw Error('Invalid deployment file record');
          const relative=safeRelative(entry.relPath),sub=entry.target?safeRelative(entry.target):'',owned=path.resolve(target,sub,relative);
          if(!within(game.root,owned)||seen.has(key(owned)))throw Error('Ambiguous deployment file path');seen.add(key(owned));
          if(affected(scope,owned))throw Error('A deployment record lists this target: '+owned+'. Ownership needs review before changing it.');
        }
        manifests.push({path:file,sha256:hash(bytes)});
      }catch(e){throw Error('Vortex ownership cannot be cleared: '+file+': '+e.message);}
    }
  }
  if(scope.files.some(file=>key(file)===key(path.join(game.mods,'mod_order.txt')))){
    // KCD2's extension writes the shared order itself, outside its deployment ledger.
    // Historical records do not prove active use, but cannot establish safe ownership either.
    if(manifests.length)throw Error('Vortex load-order ownership needs review. Its extension can write mod_order.txt even when no deployment record lists that file. Use Vortex Load Order if you use Vortex.');
    const folders=await fs.readdir(game.mods,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    if(folders.length>3000)throw Error('Cannot clear Vortex load-order ownership: folder inspection limit reached.');
    for(const folder of folders.filter(e=>e.isDirectory()||e.isSymbolicLink()))if(await exists(path.join(game.mods,folder.name,'__folder_managed_by_vortex')))throw Error('Vortex folder marker found. Load-order ownership needs review before changing mod_order.txt.');
    if(await running())throw Error('Vortex is running. Close it before this shared load-order transaction.');
  }
  return {scope,manifests};
}
module.exports={assertManualScope,normalizeScope,affected,vortexRunning,parseLedger};

'use strict';
// Steam owns these files. Read bounded metadata; never infer subscription or activation.
const fs=require('fs/promises'),path=require('path'),crypto=require('crypto');
const APP='1771300',MAX_BYTES=1024*1024;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const key=p=>path.resolve(p).toLowerCase();
const unique=values=>[...new Map(values.filter(v=>typeof v==='string'&&v.trim()).map(v=>[key(v),path.resolve(v)])).values()];
const rootsForGame=game=>unique(Array.isArray(game.workshopRoots)?game.workshopRoots:[game.workshop]);
function metadataForRoot(root){return path.basename(root)===APP&&path.basename(path.dirname(root)).toLowerCase()==='content'&&path.basename(path.dirname(path.dirname(root))).toLowerCase()==='workshop'?path.join(root,'../../appworkshop_'+APP+'.acf'):null;}
function parseVdf(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>MAX_BYTES)throw Error('Steam metadata size limit exceeded');
 if(text.includes('\0'))throw Error('Steam metadata contains NUL');
 let i=0,count=0;const tokens=[];
 while(i<text.length){
  if(/\s/.test(text[i])||text[i]==='\uFEFF'){i++;continue;}
  if(text.slice(i,i+2)==='//'){i=text.indexOf('\n',i);if(i<0)break;continue;}
  const c=text[i++];if(c==='{'||c==='}'){tokens.push(c);continue;}
  if(c!=='"')throw Error('Unsupported Steam metadata syntax');
  let s='',closed=false;while(i<text.length){const x=text[i++];if(x==='"'){closed=true;break;}if(x==='\\'){const n=text[i++];if(n==='\\'||n==='"')s+=n;else throw Error('Unsupported Steam metadata escape');}else s+=x;}
  if(!closed)throw Error('Truncated Steam metadata string');tokens.push({value:s});if(++count>50000)throw Error('Steam metadata token limit exceeded');
 }
 let at=0;function object(depth,closing){if(depth>16)throw Error('Steam metadata nesting limit exceeded');const result=Object.create(null),seen=new Set();while(at<tokens.length){if(tokens[at]==='}'){if(!closing)throw Error('Unexpected Steam metadata closing brace');at++;return result;}const t=tokens[at++];if(!t||typeof t!=='object')throw Error('Invalid Steam metadata key');const k=t.value.toLowerCase();if(seen.has(k))throw Error('Duplicate Steam metadata key: '+t.value);seen.add(k);const v=tokens[at++];if(v==='{')result[k]=object(depth+1,true);else if(v&&typeof v==='object')result[k]=v.value;else throw Error('Missing Steam metadata value');}if(closing)throw Error('Truncated Steam metadata object');return result;}
 return object(0,false);
}
async function plainAncestors(file){let current=path.resolve(file);for(let depth=0;depth<128;depth++){const st=await fs.lstat(current).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(st?.isSymbolicLink())throw Error('Linked Workshop path ancestor');const parent=path.dirname(current);if(parent===current)return;current=parent;}throw Error('Workshop ancestor limit exceeded');}
async function readBounded(file,max=MAX_BYTES){
 await plainAncestors(file);const st=await fs.lstat(file);if(st.isSymbolicLink()||!st.isFile()||st.size>max)throw Error('Steam metadata is not a bounded regular file');
 const bytes=await fs.readFile(file),after=await fs.lstat(file);if(bytes.length>max)throw Error('Steam metadata grew beyond its read limit');if(after.isSymbolicLink()||!after.isFile()||st.dev!==after.dev||st.ino!==after.ino||st.size!==after.size||st.mtimeMs!==after.mtimeMs||st.ctimeMs!==after.ctimeMs||bytes.length!==after.size)throw Error('Steam file changed during inspection');return bytes;
}
async function registeredSteamRoots(){
 if(process.platform!=='win32')return [];const run=require('util').promisify(require('child_process').execFile),roots=[];
 for(const registry of ['HKCU\\Software\\Valve\\Steam','HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam'])try{const {stdout}=await run('reg.exe',['query',registry],{windowsHide:true,timeout:3000,maxBuffer:65536});for(const m of stdout.matchAll(/(?:SteamPath|InstallPath)\s+REG_SZ\s+(.+)/gi))roots.push(m[1].trim());}catch{}
 return roots;
}
async function discoverWorkshop(gameRoot,{distribution,registryRoots}={}){
 const roots=[],metadataFiles=[],issues=[];
 const common=path.dirname(path.resolve(gameRoot)),apps=path.dirname(common),selected=path.dirname(apps);
 if(path.basename(common).toLowerCase()!=='common'||path.basename(apps).toLowerCase()!=='steamapps'||distribution!=='steam')return {roots,metadataFiles,issues};
 const libraries=[selected];
 // Only the selected Steam layout and libraries named by a Steam library file.
 const homes=unique([selected,...(registryRoots===undefined?await registeredSteamRoots():registryRoots),...[process.env['ProgramFiles(x86)'],process.env.ProgramFiles].filter(Boolean).map(p=>path.join(p,'Steam'))]);
 for(const home of homes.slice(0,32)){
  const file=path.join(home,'steamapps/libraryfolders.vdf');
  try{const v=parseVdf((await readBounded(file)).toString('utf8')).libraryfolders;if(!v||typeof v!=='object')throw Error('Missing libraryfolders object');const declared=[];for(const [id,row]of Object.entries(v)){if(!/^\d+$/.test(id))continue;const location=typeof row==='string'?row:row?.path;if(typeof location!=='string'||!path.isAbsolute(location))continue;declared.push(location);}if(key(home)===key(selected)||declared.some(p=>key(p)===key(selected)))libraries.push(...declared);}
  catch(e){if(e.code!=='ENOENT')issues.push({path:file,reason:e.message});}
 }
 if(homes.length>32||unique(libraries).length>32)issues.push({path:gameRoot,reason:'Steam library discovery limit exceeded'});
 for(const library of unique(libraries).slice(0,32)){roots.push(path.join(library,'steamapps/workshop/content',APP));metadataFiles.push(path.join(library,'steamapps/workshop','appworkshop_'+APP+'.acf'));}
 return {roots,metadataFiles,issues};
}
async function inspectWorkshop(game,{maxItems=1000}={}){
 if(!Number.isInteger(maxItems)||maxItems<1||maxItems>1000)throw Error('Invalid Workshop item limit');
 const roots=rootsForGame(game),metadataFiles=unique(Array.isArray(game.workshopMetadataFiles)?game.workshopMetadataFiles:roots.map(metadataForRoot)),issues=[...(game.workshopDiscoveryIssues||[])],items=[],rows=[];
 const issue=(p,reason)=>{if(issues.length<100)issues.push({path:p,reason});};
 if(roots.length>32){issue(game.root||roots[0],'Workshop root limit exceeded');return {roots,metadataFiles,items,issues,pending:false,complete:false,fingerprint:hash(Buffer.from(JSON.stringify({roots,issues})))};}
 const metadata=new Map();
 for(const file of metadataFiles.slice(0,32)){
  try{const bytes=await readBounded(file),v=parseVdf(bytes.toString('utf8')).appworkshop;if(!v||typeof v!=='object'||v.appid!==APP)throw Error('Workshop metadata app ID does not match KCD2');
   const installed=v.workshopitemsinstalled;if(installed!==undefined&&(!installed||typeof installed!=='object'))throw Error('Invalid installed Workshop item list');
   for(const [id,value]of Object.entries(installed||{}))if(!/^\d+$/.test(id)||!value||typeof value!=='object')throw Error('Invalid installed Workshop item record');
   const flag=x=>x===undefined?null:x==='0'?false:x==='1'?true:null;
   if(['needsupdate','needsdownload'].some(n=>v[n]!==undefined&&!['0','1'].includes(v[n])))throw Error('Invalid Workshop update flag');
   metadata.set(key(file),{installed:installed||Object.create(null),needsUpdate:flag(v.needsupdate),needsDownload:flag(v.needsdownload)});rows.push(['metadata',file,hash(bytes)]);
  }catch(e){rows.push(['metadata',file,e.code||e.message]);if(e.code!=='ENOENT')issue(file,e.message);}
 }
 if(metadataFiles.length>32)issue(game.root||metadataFiles[0],'Workshop metadata file limit exceeded');
 let itemCount=0;
 async function list(dir,limit=1000){try{await plainAncestors(dir);const s=await fs.lstat(dir);if(s.isSymbolicLink()||!s.isDirectory()){issue(dir,'Linked or non-directory Workshop path');rows.push(['unsafe',dir]);return null;}const entries=[];const handle=await fs.opendir(dir);for await(const entry of handle){entries.push(entry);if(entries.length>limit){issue(dir,'Workshop directory enumeration limit exceeded');break;}}rows.push(['directory',dir,entries.map(e=>[e.name,e.isSymbolicLink()?'link':e.isDirectory()?'dir':'file']).sort((a,b)=>a[0].localeCompare(b[0]))]);return entries;}catch(e){rows.push(['directory',dir,e.code||e.message]);if(e.code!=='ENOENT')issue(dir,e.message);return null;}}
 async function manifest(dir){const file=path.join(dir,'mod.manifest');try{const bytes=await readBounded(file,256*1024);const manifestHash=hash(bytes);rows.push(['manifest',file,manifestHash]);return {root:dir,manifestPath:file,manifestHash};}catch(e){if(e.code!=='ENOENT')issue(file,e.message);return null;}}
 let payloadCount=0;
 async function payload(dir,depth=0){
  if(depth>24){issue(dir,'Workshop payload depth limit exceeded');return;}
  if(payloadCount>=20000){issue(dir,'Workshop payload entry limit exceeded');return;}
  const entries=await list(dir,Math.min(1000,20000-payloadCount));
  for(const entry of entries||[]){if(++payloadCount>20000){issue(dir,'Workshop payload entry limit exceeded');return;}const file=path.join(dir,entry.name);
   if(entry.isSymbolicLink()){issue(file,'Linked Workshop payload');continue;}
   try{const st=await fs.lstat(file);if(st.isSymbolicLink()){issue(file,'Linked Workshop payload');continue;}rows.push(['payload',file,st.size,st.mtimeMs,st.ctimeMs,st.ino,st.dev,st.isDirectory()?'dir':'file']);if(st.isDirectory())await payload(file,depth+1);else if(!st.isFile())issue(file,'Non-regular Workshop payload');}catch(e){issue(file,'Workshop payload changed or could not be inspected: '+(e.code||e.message));}
  }
 }
 for(const root of roots){
  const entries=await list(root,maxItems),metaPath=metadataForRoot(root),meta=metaPath?metadata.get(key(metaPath)):null;
  for(const entry of entries||[])if(!/^\d+$/.test(entry.name)&&(!entry.isFile()||entry.isSymbolicLink()))issue(path.join(root,entry.name),'Unrecognized Workshop content entry');
  const numeric=new Map((entries||[]).filter(e=>/^\d+$/.test(e.name)).map(e=>[e.name,e]));
  const ids=[...new Set([...numeric.keys(),...Object.keys(meta?.installed||{})])].sort();
  for(const id of ids){if(++itemCount>maxItems){issue(root,'Workshop item limit exceeded');break;}
   const entry=numeric.get(id),itemRoot=path.join(root,id),installed=meta?Object.hasOwn(meta.installed,id):null;
   const item={root,itemRoot,itemId:id,modRoots:[],state:'unknown',metadata:{installed,needsUpdate:meta?.needsUpdate??null,needsDownload:meta?.needsDownload??null},issues:[]};items.push(item);
   const before=issues.length;
   if(!entry)item.state=meta?.needsDownload||meta?.needsUpdate?'pending':'missing';
   else if(entry.isSymbolicLink()||!entry.isDirectory())issue(itemRoot,'Linked or non-directory Workshop item');
   else{const children=await list(itemRoot);if(children){const direct=await manifest(itemRoot);if(direct)item.modRoots.push(direct);else if(children.length>50)issue(itemRoot,'Workshop item exceeds the 50-entry wrapper limit');else for(const child of children){if(child.isSymbolicLink()){issue(path.join(itemRoot,child.name),'Linked Workshop mod');continue;}if(child.isDirectory()){const m=await manifest(path.join(itemRoot,child.name));if(m)item.modRoots.push(m);}}}
    item.state=meta?.needsDownload||meta?.needsUpdate?'pending':installed&&item.modRoots.length?'installed':'unknown';if(!item.modRoots.length&&item.state!=='pending')issue(itemRoot,'Workshop item has no discoverable mod manifest');}
   for(const mod of item.modRoots)await payload(mod.root);
   item.issues=issues.slice(before);
   if(item.issues.length)item.state='unknown';
  }
  if(itemCount>maxItems)break;
 }
 return {roots,metadataFiles,items,issues,pending:[...metadata.values()].some(m=>m.needsUpdate||m.needsDownload),complete:issues.length===0,fingerprint:hash(Buffer.from(JSON.stringify({rows,items,issues})))};
}
module.exports={APP,parseVdf,rootsForGame,metadataForRoot,discoverWorkshop,inspectWorkshop};

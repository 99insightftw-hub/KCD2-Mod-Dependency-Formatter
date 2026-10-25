'use strict';
// Filename hints select likely downloads. The archive validator establishes identity.
// This module only reads directory entries and file metadata, never archive bytes.
const fs=require('fs/promises'),path=require('path');
const {nexusIds}=require('./catalog');
const {inspectFolder}=require('./extracted-folder');
const MIB=1024*1024;
const hints=[
  ['kcse',/\bkcse\b|kingdom[ _.-]*come[ _.-]*script[ _.-]*extender/i],
  ['addresslib',/address[ _.-]*(?:lib(?:rary)?|library[ _.-]*for[ _.-]*kcse)/i],
  ['kcdutils',/\bkcd[ _.-]*utils\b/i],
  ['luautils',/\blua[ _.-]*utils\b/i],
  ['luadb',/\blua[ _.-]*db\b|\bkcd2[ _.-]*db\b/i],
  ['asi',/\bultimate[ _.-]*asi[ _.-]*loader\b/i],
  ['ptfextender',/\bptf[ _.-]*extender\b/i],
  ['mcm',/\bmcm\b|\bmod[ _.-]*configuration[ _.-]*menu\b/i],
  ['consolerpgparam',/\bconsole[ _.-]*(?:editable[ _.-]*)?rpg[ _.-]*params?\b/i],
];
const ids=new Set(hints.map(([id])=>id));
function dependencyHints(name) {
  const normalized=name.replace(/_/g,' '),found=new Set();
  if(/sound[ _.-]*framework/i.test(normalized)){if(/\bkcse\b/i.test(normalized))return ['soundframework'];if(/\basi\b/i.test(normalized)||/^kcd2[ _.-]*sound[ _.-]*framework[ _.-]*v[0-9]/i.test(normalized))return ['soundframework_asi'];return ['soundframework','soundframework_asi'];}
  for(const [id,re] of hints)if(re.test(normalized))found.add(id);
  for(const [id,nexus] of Object.entries(nexusIds))if(ids.has(id)&&new RegExp('(?:^|[^0-9])'+nexus+'(?:[^0-9]|$)').test(name))found.add(id);
  return [...found];
}
function bounded(value,fallback,maximum) {
  if(value===undefined)return fallback;
  if(!Number.isSafeInteger(value)||value<1||value>maximum)throw Error('Invalid download discovery limit.');
  return value;
}
async function plainFolder(folder) {
  let current=folder;
  while(true) {
    const s=await fs.lstat(current);
    if(s.isSymbolicLink())throw Error('Choose a download folder without symbolic links or junctions.');
    if(current===folder&&!s.isDirectory())throw Error('Choose a download folder.');
    const parent=path.dirname(current);if(parent===current)break;current=parent;
  }
}
async function discoverDownloads(folder,options={}) {
  if(typeof folder!=='string'||!folder.trim())throw Error('Choose a download folder.');
  const root=path.resolve(folder),maxEntries=bounded(options.maxEntries,500,2000),maxCandidates=bounded(options.maxCandidates,24,50);
  const maxBytes=bounded(options.maxBytes,256*MIB,256*MIB),maxTotalBytes=bounded(options.maxTotalBytes,512*MIB,1024*MIB);
  const stabilityMs=options.stabilityMs===undefined?1500:options.stabilityMs;
  if(!Number.isSafeInteger(stabilityMs)||stabilityMs<0||stabilityMs>60000)throw Error('Invalid download stability interval.');
  const now=options.now===undefined?Date.now():options.now;
  if(!Number.isFinite(now))throw Error('Invalid observation time.');
  await plainFolder(root);
  const prior=new Map();
  for(const item of (Array.isArray(options.known)?options.known:[]).slice(0,2000))if(item&&typeof item.path==='string')prior.set(path.resolve(item.path).toLowerCase(),item);
  const candidates=[],pending=[],observations=[],warnings=[];let entries=0,bytes=0,folderAttempts=0;
  const directory=await fs.opendir(root);
  for await(const entry of directory) {
    if(++entries>maxEntries){warnings.push('Only the first '+maxEntries+' entries were checked. Choose a smaller download folder to see the rest.');break;}
    if(entry.isDirectory()&&!entry.isSymbolicLink()&&dependencyHints(entry.name).length&&!/backup|quarantine|staging|source|src/i.test(entry.name)){
      if(observations.length>=maxCandidates||++folderAttempts>24)continue;
      const file=path.join(root,entry.name);
      try{const info=await inspectFolder(file);if(!info.size||bytes+info.size>maxTotalBytes)continue;bytes+=info.size;
      const stat=await fs.lstat(file),previous=prior.get(file.toLowerCase()),unchanged=previous?.fingerprint===info.fingerprint&&Number.isFinite(previous.firstSeenAt)&&previous.lastSeenAt<=now&&now-previous.lastSeenAt<=600000;
      const firstSeenAt=unchanged?previous.firstSeenAt:now,item={path:file,name:entry.name,kind:'folder',size:info.size,mtimeMs:stat.mtimeMs,fingerprint:info.fingerprint,dependencyHints:dependencyHints(entry.name)};
      observations.push({...item,firstSeenAt,lastSeenAt:now});
      if(unchanged&&now-firstSeenAt>=stabilityMs)candidates.push(item);else pending.push({...item,reason:'Waiting for a second unchanged observation.'});
      }catch{warnings.push('An extracted folder could not be checked: '+entry.name);}continue;
    }
    if(!entry.isFile()||entry.isSymbolicLink()||! /\.(zip|7z)$/i.test(entry.name))continue;
    if(/(?:^|[._ -])(?:crdownload|part|partial|download|tmp|temp)(?:[._ -]|$)/i.test(entry.name))continue;
    const guessed=dependencyHints(entry.name);if(!guessed.length)continue;
    if(/(?:^|[._ -])(?:source|sources|src|readme|notes)(?:[._ -]|$)/i.test(entry.name)&&
      guessed.every(id=>id==='consolerpgparam'||id.startsWith('soundframework')))continue;
    const file=path.join(root,entry.name);let s;
    try{s=await fs.lstat(file);}catch(e){if(e.code==='ENOENT')continue;throw e;}
    if(!s.isFile()||s.isSymbolicLink()||s.nlink>1){warnings.push('A linked download was skipped: '+entry.name);continue;}
    if(s.size===0)continue;
    if(s.size>maxBytes){warnings.push('Download exceeds the '+Math.floor(maxBytes/MIB)+' MB discovery limit: '+entry.name);continue;}
    if(observations.length>=maxCandidates||bytes+s.size>maxTotalBytes){warnings.push('Download candidate limit reached. Choose a smaller folder or select a file manually.');continue;}
    bytes+=s.size;
    const previous=prior.get(file.toLowerCase());
    const unchanged=previous&&previous.size===s.size&&previous.mtimeMs===s.mtimeMs&&previous.birthtimeMs===s.birthtimeMs&&previous.ino===s.ino&&Number.isFinite(previous.firstSeenAt)&&Number.isFinite(previous.lastSeenAt)&&previous.lastSeenAt<=now&&now-previous.lastSeenAt<=10*60*1000;
    const firstSeenAt=unchanged?previous.firstSeenAt:now;
    observations.push({path:file,size:s.size,mtimeMs:s.mtimeMs,birthtimeMs:s.birthtimeMs,ino:s.ino,firstSeenAt,lastSeenAt:now});
    const item={path:file,name:entry.name,size:s.size,mtimeMs:s.mtimeMs,dependencyHints:guessed};
    if(unchanged&&firstSeenAt<=now&&now-firstSeenAt>=stabilityMs)candidates.push(item);
    else pending.push({...item,reason:unchanged?'Waiting for the download to settle.':'Waiting for a second unchanged observation.'});
  }
  // Stable order avoids list flicker when filesystem enumeration changes.
  const order=(a,b)=>a.name.localeCompare(b.name);
  candidates.sort(order);pending.sort(order);
  return {folder:root,candidates,pending,observations,warning:warnings.length?[...new Set(warnings)].join(' '):null};
}
function commonDownloadRoots({preferred,downloads,desktop,documents,home}={}) {
 const values=[preferred,downloads,desktop,documents];
 if(typeof home==='string'&&path.isAbsolute(home))for(const name of ['Downloads','Desktop','Documents'])values.push(path.join(home,name));
 const seen=new Set();return values.filter(value=>{
  if(typeof value!=='string'||!path.isAbsolute(value))return false;
  const key=path.resolve(value).toLowerCase();if(seen.has(key))return false;seen.add(key);return true;
 }).map(value=>path.resolve(value));
}
async function discoverCommonDownloads(roots,options={}) {
 const ordered=commonDownloadRoots({preferred:roots?.[0]});
 for(const root of Array.isArray(roots)?roots.slice(1,8):[])if(typeof root==='string'&&path.isAbsolute(root)&&!ordered.some(p=>p.toLowerCase()===path.resolve(root).toLowerCase()))ordered.push(path.resolve(root));
 const folders=[],candidates=[],pending=[],observations=[],warnings=[],seen=new Set();
 let exhausted=false;
 async function inspect(folder){
  const key=path.resolve(folder).toLowerCase();if(seen.has(key)||seen.size>=24)return;
  seen.add(key);
  try{
   const result=await discoverDownloads(folder,{...options,maxEntries:500,maxCandidates:24});
   folders.push(folder);if(result.warning)warnings.push(result.warning);
   const remaining=96-observations.length;
   const accepted=new Set(result.observations.slice(0,remaining).map(row=>row.path));
   observations.push(...result.observations.slice(0,remaining));
   candidates.push(...result.candidates.filter(row=>accepted.has(row.path)));
   pending.push(...result.pending.filter(row=>accepted.has(row.path)));
   if(result.observations.length>remaining||observations.length>=96)exhausted=true;
  }catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))warnings.push('Could not check downloads. Use Choose ZIP or 7z or Refresh.');}
 }
 // Scan likely root locations first; only then inspect clearly named mod/download subfolders.
 for(const root of ordered){await inspect(root);if(exhausted)break;}
 if(!exhausted)for(const root of ordered){
  try{
   await plainFolder(root);let count=0;const children=[];
   for await(const entry of await fs.opendir(root)){
    if(++count>500)break;
    if(entry.isDirectory()&&!entry.isSymbolicLink()&&/^(?:kcd2?|kingdom.?come|mods?|plugins?|dependencies|archives?|downloads?)(?:$|[ _.-])/i.test(entry.name)&&!/backup|quarantine|staging/i.test(entry.name))children.push(entry.name);
   }
   for(const name of children.sort()){await inspect(path.join(root,name));if(exhausted||seen.size>=24)break;}
  }catch{/* Missing/inaccessible optional roots do not stop other locations. */}
  if(exhausted||seen.size>=24)break;
 }
 if(exhausted||seen.size>=24)warnings.push('Download candidate limit reached. Choose a smaller folder or select a file manually.');
 return {folder:ordered[0]||'',folders,candidates,pending,observations,warning:[...new Set(warnings)].join(' ')||null};
}
module.exports={discoverDownloads,discoverCommonDownloads,commonDownloadRoots};

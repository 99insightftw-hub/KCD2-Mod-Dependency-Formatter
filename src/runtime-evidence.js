'use strict';
// Read-only clues from existing logs. Never change dependency status based on logs.
const fs=require('fs/promises'),path=require('path');
const LIMIT=256*1024;
const NOTE='These messages were saved by the game and may be out of date. Launch the game and try your mods to check that they work.';
const SOURCES=['KCSE/logs/KCSE.log','kcd.log','kcd2db.log'];
const names={kcse:'KCSE',mcm:'MCM',luautils:'LuaUtils',ptfextender:'PTF Extender',kcdutils:'KCDUtils',luadb:'LuaDB'};
function workshopProviders({mods=[],workshopRoots=[]}={}){
  // Only exact roots from the current scan qualify. A saved log cannot establish
  // current subscription, enablement, file identity, or runtime compatibility.
  const normalize=value=>typeof value==='string'&&path.isAbsolute(value)&&!value.split(/[\\/]/).includes('..')?path.resolve(value).toLowerCase():null;
  const roots=(Array.isArray(workshopRoots)?workshopRoots:[]).slice(0,32).map(normalize).filter(Boolean),providers=[];
  for(const mod of (Array.isArray(mods)?mods:[]).slice(0,1000)){
    if(!mod?.workshop||typeof mod.workshopItemId!=='string'||! /^[1-9][0-9]{0,19}$/.test(mod.workshopItemId))continue;
    const root=normalize(mod.root);if(!root)continue;
    if(!roots.some(base=>root.startsWith(base+path.sep)&&path.relative(base,root).split(path.sep)[0]===mod.workshopItemId))continue;
    providers.push({root,itemId:mod.workshopItemId,name:String(mod.name||mod.id||mod.workshopItemId).slice(0,120)});
  }
  return providers;
}
function cluesFrom(text,source,context={}){
  const clues=[];
  const providers=source==='kcd.log'?workshopProviders(context):[];
  for(const raw of text.split(/\r\n|\n|\r/)){
    let plugin,kind;
    const line=raw.trim();
    if(source==='KCSE/logs/KCSE.log'){
      const message=line.replace(/^\[[^\]]+\]\s*\[(?:info|error|warning|warn|debug)\]\s*/i,'');
      if(/^KCSE v\d+\b/.test(message)){plugin='kcse';kind='startup';}
      const loaded=/^Loaded (MCM|LuaUtils|PTF Extender)\s*$/.exec(message);
      if(loaded){plugin={MCM:'mcm',LuaUtils:'luautils','PTF Extender':'ptfextender'}[loaded[1]];kind='loaded';}
    }
    if(source==='kcd.log'){
      const opened=/^Pak '([^'\r\n]+\.pak)' is opened, root: '[^'\r\n]*'$/.exec(line);
      if(opened&&path.isAbsolute(opened[1])&&!opened[1].split(/[\\/]/).includes('..')){
        const file=path.resolve(opened[1]).toLowerCase(),provider=providers.find(p=>file.startsWith(p.root+path.sep));
        if(provider){
          const id='workshop:'+provider.itemId,same=clues.filter(c=>c.plugin===id);
          if(same.length>=3)clues.splice(clues.indexOf(same[0]),1);
          const all=clues.filter(c=>c.workshopItemId);if(all.length>=60)clues.splice(clues.indexOf(all[0]),1);
          clues.push({plugin:id,name:'Steam Workshop · '+provider.name,kind:'activity',line:line.slice(0,800),workshopItemId:provider.itemId});
        }
      }
      if(/^\[MCM\] (?:settings rebuilt: \d+ mod\(s\)|opened \(\d+ mods\))$/.test(line)){plugin='mcm';kind='activity';}
      if(/^KCDUtils: Initialization complete\.$/.test(line)){plugin='kcdutils';kind='loaded';}
      if(/^\[LuaUtils\] RTTR wrappers loaded:/.test(line)){plugin='luautils';kind='activity';}
      if(/^\[PTFextender\].* is patched by /.test(line)){plugin='ptfextender';kind='activity';}
    }
    if(source==='kcd2db.log'&&/^\[INFO\]\s+LuaDB loading completed\.$/.test(line)){plugin='luadb';kind='loaded';}
    if(/\[(?:error|fatal|warning|warn)\]|\bfailed\b|\bincompatible\b/i.test(line)){
      const match=/\b(MCM|LuaUtils|PTF\s*Extender|KCDUtils|LuaDB|kcd2db|KCSE)\b/i.exec(line);
      if(match){plugin=match[1].toLowerCase().replace(/\s/g,'');if(plugin==='kcd2db')plugin='luadb';kind='error';}
    }
    if(plugin&&kind){
      // Keep bounded evidence per plugin and kind, including errors after successes.
      const same=clues.filter(c=>c.plugin===plugin&&c.kind===kind);
      if(same.length>=3)clues.splice(clues.indexOf(same[0]),1);
      clues.push({plugin,name:names[plugin],kind,line:line.slice(0,800)});
    }
  }
  return clues;
}
async function readLog(root,source,context){
  const file=path.join(root,source),result={file,modified:null,status:'missing',truncated:false,clues:[]};
  let handle;
  try{
    const entry=await fs.lstat(file);
    if(!entry.isFile()||entry.isSymbolicLink())return {...result,status:'skipped',detail:'This log is not a regular file.'};
    handle=await fs.open(file,'r');
    const before=await handle.stat();
    if(!before.isFile())return {...result,status:'skipped',detail:'This log is not a regular file.'};
    const start=Math.max(0,before.size-LIMIT),buffer=Buffer.alloc(Math.min(before.size,LIMIT));
    const {bytesRead}=await handle.read(buffer,0,buffer.length,start);
    let text=buffer.subarray(0,bytesRead).toString('utf8');
    // A partial first line must never become a success clue.
    if(start){const boundary=text.search(/[\r\n]/);text=boundary<0?'':text.slice(boundary+1);}
    const after=await handle.stat();
    return {...result,status:'read',modified:before.mtime.toISOString(),truncated:start>0,
      changedDuringRead:before.size!==after.size||before.mtimeMs!==after.mtimeMs,
      clues:cluesFrom(text,source,context)};
  }catch(error){return {...result,status:error.code==='ENOENT'?'missing':'unreadable',detail:error.code==='ENOENT'?'No saved log found.':'Could not read this log. File checks can still continue.'};}
  finally{if(handle)await handle.close().catch(()=>{});}
}
async function inspectRuntimeEvidence(game,{mods=[]}={}){
  const context={mods:Array.isArray(mods)?mods:[],workshopRoots:Array.isArray(game.workshopRoots)?game.workshopRoots:game.workshop?[game.workshop]:[]};
  return {note:NOTE,logs:await Promise.all(SOURCES.map(source=>readLog(game.root,source,context)))};
}
module.exports={inspectRuntimeEvidence,cluesFrom,LIMIT};

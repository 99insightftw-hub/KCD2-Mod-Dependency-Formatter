'use strict';
const fs=require('fs/promises'),path=require('path'),assert=require('assert/strict'),Zip=require('adm-zip');
const {resolveGame}=require('../src/discovery');
const {prepareDownload,installPrepared,undoPrepared}=require('../src/downloads');
const base=path.resolve(__dirname,'../../test-output/download-safety-'+Date.now());
let checks=0;const ok=v=>{assert(v);checks++;},rejects=async(fn,re)=>{await assert.rejects(fn,re);checks++;};
const put=async(p,b)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,b);};
const exists=async p=>!!await fs.stat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
async function fixture(name){
 const root=path.join(base,name);await put(path.join(root,'Bin/Win64MasterMasterSteamPGO/KingdomCome.exe'),'fixture');await put(path.join(root,'Bin/Win64MasterMasterSteamPGO/WHGame.dll'),'fixture');
 await fs.mkdir(path.join(root,'Data'));await fs.mkdir(path.join(root,'mods'));
 const game=await resolveGame(root);return {game,report:{game,snapshots:{}},store:path.join(base,name+'-receipts')};
}
async function archive(name,id,display='LuaUtils'){
 const zip=new Zip();zip.addFile('wrapper/mod.manifest',Buffer.from('<kcd_mod><info>'+(id===null?'':'<modid>'+id+'</modid>')+'<name>'+display+'</name></info></kcd_mod>'));
 const file=path.join(base,name+'.zip');await put(file,zip.toBuffer());return file;
}
async function main(){
 const f=await fixture('identity');
 for(const [i,id] of ['..','.','unrelated_mod','kcdutils','../luautils','luautils.'].entries()){
  const file=await archive('unsafe-'+i,id);
  await rejects(()=>prepareDownload(file,f.game),/conflicts|unsafe|Unsafe/);
 }
 ok(!await exists(path.join(f.game.root,'mod.manifest')));
 ok((await fs.readdir(f.game.mods)).length===0);
 const named=await prepareDownload(await archive('name-only',null),f.game);
 ok(named.files.every(x=>x.target.startsWith(path.join(f.game.mods,'luautils')+path.sep)));
 const installed=await installPrepared(named,f.report,f.store,null,{closed:async()=>true});
 ok(await exists(path.join(f.game.mods,'luautils/mod.manifest')));
 await undoPrepared(installed.receipt,f.store,{closed:async()=>true});
 ok(!await exists(path.join(f.game.mods,'luautils/mod.manifest')));
 ok(!await exists(path.join(f.game.root,'mod.manifest')));
 // Reproduce a game launch during a slow staging write: no target promotion.
 const race=await fixture('install-race'),plan=await prepareDownload(await archive('race','luautils'),race.game);
 let closed=true;const open=fs.open;
 fs.open=async function(file,...args){const handle=await open.call(this,file,...args);if(path.basename(String(file)).startsWith('.dependency-checker-')){const stageWrite=handle.writeFile.bind(handle);handle.writeFile=async(...writeArgs)=>{const result=await stageWrite(...writeArgs);closed=false;return result;};}return handle;};
 try{await rejects(()=>installPrepared(plan,race.report,race.store,null,{closed:async()=>closed}),/started|running/);}finally{fs.open=open;}
 ok(!await exists(plan.files[0].target));
 // Launch during undo's quarantine copy must leave the installed file intact.
 const ready=await installPrepared(await prepareDownload(plan.source,race.game),race.report,race.store,null,{closed:async()=>true});
 const copy=fs.copyFile;closed=true;
 fs.copyFile=async function(src,dst,...args){const result=await copy.call(this,src,dst,...args);if(path.basename(String(dst)).startsWith('removed-'))closed=false;return result;};
 try{await rejects(()=>undoPrepared(ready.receipt,race.store,{closed:async()=>closed}),/started/);}finally{fs.copyFile=copy;}
 ok(await exists(plan.files[0].target));
 await undoPrepared(ready.receipt,race.store,{closed:async()=>true});
 ok(!await exists(plan.files[0].target));
 // Launch during restoration of an existing file must retain the new version.
 const old='<kcd_mod><info><modid>luautils</modid><name>Old</name></info></kcd_mod>';
 await put(plan.files[0].target,old);
 const replacement=await installPrepared(await prepareDownload(plan.source,race.game),race.report,race.store,null,{closed:async()=>true});
  closed=true;fs.open=async function(file,...args){const handle=await open.call(this,file,...args);if(path.basename(String(file)).startsWith('.dependency-checker-undo-')){const stageWrite=handle.writeFile.bind(handle);handle.writeFile=async(...writeArgs)=>{const result=await stageWrite(...writeArgs);closed=false;return result;};}return handle;};
  try{await rejects(()=>undoPrepared(replacement.receipt,race.store,{closed:async()=>closed}),/started/);}finally{fs.open=open;}
 ok((await fs.readFile(plan.files[0].target,'utf8'))!==old);
 await undoPrepared(replacement.receipt,race.store,{closed:async()=>true});
 ok((await fs.readFile(plan.files[0].target,'utf8'))===old);
 console.log('Download safety passed: '+checks+' assertions. '+base);
}
main().catch(e=>{console.error(e);process.exitCode=1;});

'use strict';
// Starts the scanned installation with -devmode. Steam copies go through the
// Steam client so DRM and overlay behave normally; other stores run the exe.
const fs=require('fs/promises'),path=require('path');
const {resolveGame}=require('./discovery');
const {gameClosed}=require('./repairs');
const STEAM_APP=1771300,ARGS=['-devmode'];
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();

async function launchPlan(game) {
  if(!game?.root||!game?.bin)throw Error('Check your setup first.');
  const exe=path.join(game.bin,'KingdomCome.exe');
  const current=await resolveGame(exe);
  if(!same(current.root,game.root)||!same(current.bin,game.bin))throw Error('Selected installation changed. Check your setup again.');
  const st=await fs.lstat(exe).catch(()=>null);
  if(!st?.isFile())throw Error('KingdomCome.exe was not found in the selected installation.');
  if(game.distribution==='steam')return {kind:'steam',url:`steam://run/${STEAM_APP}//${ARGS.join(' ')}/`,args:ARGS,exe};
  if(game.distribution==='xbox')throw Error('Xbox installations cannot be started with launch options from this app.');
  return {kind:'exe',exe,cwd:game.bin,args:ARGS};
}

async function launchDevmode(game,{closed=gameClosed,openExternal,spawn}) {
  const plan=await launchPlan(game);
  if(!await closed())throw Error('Kingdom Come: Deliverance II is already running.');
  if(plan.kind==='steam')await openExternal(plan.url);
  else {
    const child=spawn(plan.exe,plan.args,{cwd:plan.cwd,detached:true,stdio:'ignore',windowsHide:false});
    await new Promise((resolve,reject)=>{
      child.once('spawn',resolve);
      child.once('error',reject);
    });
    child.unref();
  }
  return plan;
}
module.exports={launchPlan,launchDevmode,STEAM_APP};

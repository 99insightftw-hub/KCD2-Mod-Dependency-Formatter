'use strict';
const {parentPort,workerData}=require('worker_threads');
const {prepareDownload,exportPrepared}=require('./downloads');
const flag=new Int32Array(workerData.cancel),controller=new AbortController();
function check(){if(Atomics.load(flag,0))throw Error('Cancelled.');}
const timer=setInterval(()=>{if(Atomics.load(flag,0))controller.abort();},40);
let last=0;
const onProgress=progress=>{const now=Date.now();if(now-last>=100){last=now;parentPort.postMessage({progress});}};
async function main(){
  const options={check,onProgress,signal:controller.signal};
  if(workerData.operation==='check')return prepareDownload(workerData.file,workerData.game,workerData.sevenZip,options);
  if(workerData.operation==='export')return exportPrepared(workerData.plan,workerData.game,workerData.destination,workerData.sevenZip,{...options,vortex:workerData.vortex,workshopFingerprint:workerData.workshopFingerprint});
  throw Error('Unknown archive operation');
}
main().then(result=>parentPort.postMessage({result})).catch(e=>parentPort.postMessage({error:Atomics.load(flag,0)&&!e.message.includes('Incomplete output')?'Cancelled.':e.message}))
  .finally(()=>{clearInterval(timer);parentPort.close();});

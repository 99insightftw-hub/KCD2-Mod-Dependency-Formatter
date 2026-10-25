'use strict';
// Client for the per-user Vortex helper. No Vortex database or staging writes.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net');
const protocol=require('./vortex-helper/bridge-protocol');
const {hashFile}=require('./io');
const supportedHelper=version=>/^0\.2\.\d+$/.test(version)&&Number(version.split('.')[2])>=6;
const helperUpdateMessage='Update the Vortex helper to version 0.2.6 or newer before installing or repairing dependencies.';
async function plain(target){
 for(let p=path.resolve(target);;p=path.dirname(p)){
  const s=await fs.lstat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(s&&(s.isSymbolicLink()||s.isFile()&&s.nlink>1))throw Error('The Vortex connection folder must not contain linked paths.');
  if(path.dirname(p)===p)break;
 }
}
async function descriptor(base){
 const file=path.join(base,'session.json');await plain(file);
 const s=await fs.stat(file);if(!s.isFile()||s.size>4096)throw Error('Invalid Vortex connection record.');
 return protocol.validateDescriptor(JSON.parse(await fs.readFile(file,'utf8')));
}
function exchange(endpoint,request,{timeoutMs=5000,onProgress=()=>{},connect=net.createConnection}={}){
 protocol.validateDescriptor(endpoint);protocol.validateRequest(request);
 return new Promise((resolve,reject)=>{
  let socket,finished=false,sent=false;
  const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);socket?.destroy();if(error){error.requestSent=sent;reject(error);}else resolve(value);};
  const timer=setTimeout(()=>finish(Error('Vortex did not finish responding. Check Vortex and the saved request before trying again.')),timeoutMs);
  const parser=protocol.createFrameParser(value=>{
   protocol.validateResponse(value);if(value.id!==request.id)throw Error('Vortex response belongs to another request.');
   if(value.type==='progress'){onProgress(value.message);return;}
   if(!value.ok)finish(Error(value.error));else finish(null,value.value);
  },{multiple:true});
  try{
   socket=connect({path:endpoint.pipe});
   socket.on('connect',()=>{sent=true;socket.write(protocol.encodeFrame(request));});
   socket.on('data',chunk=>{try{parser(chunk);}catch(e){finish(e);}});
   socket.on('error',error=>finish(error));
   socket.on('end',()=>{if(!finished)finish(Error('Vortex closed the connection before confirming the result.'));});
  }catch(error){finish(error);}
 });
}
async function status(base,gameRoot,options={}){
 try{
  const endpoint=await descriptor(base),id=crypto.randomUUID();
  const value=await exchange(endpoint,{protocol:protocol.PROTOCOL,token:endpoint.token,id,op:'status'},options);
  if(!value||typeof value.ready!=='boolean')throw Error('Unsupported Vortex helper response.');
  let ready=value.ready,message=value.message||'Vortex is connected.';
  if(!supportedHelper(endpoint.helperVersion)){ready=false;message=helperUpdateMessage;}
  if(ready&&(!value.profileId||!value.gameRoot)){ready=false;message='Select your KCD2 profile in Vortex.';}
  if(ready&&gameRoot){const a=await fs.realpath(gameRoot),b=await fs.realpath(value.gameRoot);if(a.toLowerCase()!==b.toLowerCase()){ready=false;message='Vortex is managing a different game folder. Select the same installation in both apps.';}}
  return {...value,connected:true,ready,message,helperVersion:endpoint.helperVersion};
 }catch(error){return {connected:false,ready:false,message:error.code==='ENOENT'?'Open Vortex with the formatter helper enabled. Export and install the helper once if needed.':'Vortex connection unavailable: '+error.message};}
}
async function createJob(base){
 await plain(base);const id=crypto.randomUUID(),directory=protocol.jobDirectory(base,id);
 await fs.mkdir(path.dirname(directory),{recursive:true});await plain(path.dirname(directory));await fs.mkdir(directory);
 return {id,directory};
}
async function install(base,job,gameRoot,profileId,{onProgress=()=>{},timeoutMs=15*60*1000,connect,gameBin,workshopFingerprint}={}){
 if(path.resolve(job.directory)!==protocol.jobDirectory(base,job.id))throw Error('Invalid Vortex job directory.');
 await plain(job.directory);const packages=[];
 if(await fs.stat(path.join(job.directory,'INCOMPLETE.txt')).catch(()=>null))throw Error('Dependency export did not finish.');
 for(const name of (await fs.readdir(job.directory)).filter(n=>/^dependency-.*\.zip$/i.test(n)).sort()){
  const file=protocol.packagePath(base,job.id,name);await plain(file);const st=await fs.stat(file);
  if(!st.isFile())throw Error('Invalid dependency package');packages.push({name,bytes:st.size,sha256:await hashFile(file)});
 }
 const endpoint=await descriptor(base);if(!supportedHelper(endpoint.helperVersion))throw Error(helperUpdateMessage);
 const request=protocol.validateRequest({protocol:protocol.PROTOCOL,token:endpoint.token,id:job.id,op:'install',gameRoot,...(gameBin?{gameBin}:{}),profileId,packages,workshopFingerprint});
 const receipt=path.join(job.directory,'client-request.json');
 // Never put the session token into durable receipts or logs.
 const record={...request,token:undefined,createdAt:new Date().toISOString(),state:'submitted'};
 await fs.writeFile(receipt,JSON.stringify(record,null,2),{flag:'wx'});
 let responseReceived=false;
 try{
  const value=await exchange(endpoint,request,{timeoutMs,onProgress,connect});
  responseReceived=true;
  if(!value||!['completed','failed','needs-attention'].includes(value.state))throw Error('Unrecognized Vortex installation result; check the saved request.');
  await fs.writeFile(path.join(job.directory,'client-result.json'),JSON.stringify(value,null,2),{flag:'wx'});
  return {...value,receipt};
 }catch(error){
  const value={state:'needs-attention',message:error.message+' This request will not be retried automatically.',receipt,requestMayHaveStarted:responseReceived||!!error.requestSent};
  try{await fs.writeFile(path.join(job.directory,'client-result.json'),JSON.stringify(value,null,2),{flag:'wx'});}catch(saveError){value.message+=' The result record could not be saved: '+saveError.message;}
  return value;
 }
}
module.exports={...protocol,plain,descriptor,exchange,status,createJob,install};

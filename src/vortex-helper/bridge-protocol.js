'use strict';
// Local bridge wire contract only. This module never reads or changes Vortex state.
const path=require('node:path'),crypto=require('node:crypto');
const PROTOCOL=1,MAX_FRAME_BYTES=64*1024,MAX_PACKAGE_BYTES=256*1024*1024,MAX_TOTAL_BYTES=512*1024*1024,MAX_PACKAGES=32;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX=/^[a-f0-9]{64}$/;
const PIPE=/^\\\\\.\\pipe\\kcd2-formatter-[a-f0-9]{64}$/;
function object(value,label){if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)throw Error('Invalid '+label);}
function keys(value,allowed,label){object(value,label);for(const key of Object.keys(value))if(!allowed.includes(key))throw Error('Unexpected '+label+' field: '+key);}
function text(value,max,label){if(typeof value!=='string'||!value.length||value.length>max||/[\x00-\x1f\x7f]/.test(value))throw Error('Invalid '+label);return value;}
function requestId(value){if(typeof value!=='string'||!UUID.test(value))throw Error('Invalid request id');return value;}
function token(value){if(typeof value!=='string'||!HEX.test(value))throw Error('Invalid session token');return value;}
function bridgeRoot(appData){text(appData,1024,'application data path');if(!path.isAbsolute(appData))throw Error('Application data path must be absolute');return path.join(appData,'Elfis Combat Setup','vortex-bridge');}
function validateDescriptor(value){
 keys(value,['protocol','pipe','token','pid','startedAt','helperVersion'],'descriptor');
 if(value.protocol!==PROTOCOL||typeof value.pipe!=='string'||!PIPE.test(value.pipe))throw Error('Unsupported bridge descriptor');
 token(value.token);if(!Number.isSafeInteger(value.pid)||value.pid<1)throw Error('Invalid helper process');
 text(value.helperVersion,40,'helper version');text(value.startedAt,40,'helper start time');
 if(!Number.isFinite(Date.parse(value.startedAt)))throw Error('Invalid helper start time');
 return value;
}
function validatePackage(value){
 keys(value,['name','bytes','sha256'],'package');
 if(typeof value.name!=='string'||value.name.length>180||!/^dependency-[a-z0-9][a-z0-9._-]*\.zip$/i.test(value.name))throw Error('Invalid package filename');
 if(!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>MAX_PACKAGE_BYTES||typeof value.sha256!=='string'||!HEX.test(value.sha256))throw Error('Invalid package identity');
 return value;
}
function validateRequest(value){
 keys(value,['protocol','token','id','op','gameRoot','gameBin','profileId','packages','workshopFingerprint'],'request');
 if(value.protocol!==PROTOCOL)throw Error('Unsupported bridge protocol');token(value.token);requestId(value.id);
 if(value.op==='status'){
  if(['gameRoot','gameBin','profileId','packages','workshopFingerprint'].some(k=>Object.hasOwn(value,k)))throw Error('Status request cannot include install data');
 }else if(value.op==='install'){
  text(value.gameRoot,1024,'game path');if(!path.isAbsolute(value.gameRoot))throw Error('Game path must be absolute');
  if(Object.hasOwn(value,'gameBin')){text(value.gameBin,1024,'game executable directory');if(!path.isAbsolute(value.gameBin))throw Error('Game executable directory must be absolute');}
  text(value.profileId,200,'profile id');
  if(typeof value.workshopFingerprint!=='string'||!HEX.test(value.workshopFingerprint))throw Error('Invalid Workshop fingerprint');
  if(!Array.isArray(value.packages)||!value.packages.length||value.packages.length>MAX_PACKAGES)throw Error('Invalid package list');
  const names=new Set();let total=0;
  for(const entry of value.packages){validatePackage(entry);const key=entry.name.toLowerCase();if(names.has(key))throw Error('Duplicate package filename');names.add(key);total+=entry.bytes;}
  if(total>MAX_TOTAL_BYTES)throw Error('Package total exceeds limit');
 }else throw Error('Unknown bridge operation');
 return value;
}
function jobDirectory(root,id){text(root,1024,'bridge root');if(!path.isAbsolute(root))throw Error('Bridge root must be absolute');requestId(id);return path.join(root,'jobs',id);}
function packagePath(root,id,name){validatePackage({name,bytes:1,sha256:'0'.repeat(64)});return path.join(jobDirectory(root,id),name);}
function sameToken(a,b){if(typeof a!=='string'||typeof b!=='string'||!HEX.test(a)||!HEX.test(b))return false;return crypto.timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
function encodeFrame(value){const bytes=Buffer.from(JSON.stringify(value)+'\n','utf8');if(bytes.length>MAX_FRAME_BYTES)throw Error('Bridge frame exceeds limit');return bytes;}
function validateResponse(value){
 object(value,'response');if(value.protocol!==PROTOCOL)throw Error('Unsupported response protocol');requestId(value.id);
 if(value.type==='progress'){
  keys(value,['protocol','id','type','message'],'progress');text(value.message,1000,'progress message');
 }else{
  keys(value,['protocol','id','ok','value','error'],'response');if(typeof value.ok!=='boolean')throw Error('Invalid response result');
  if(value.ok){if(!Object.hasOwn(value,'value')||Object.hasOwn(value,'error'))throw Error('Invalid success response');}
  else{if(Object.hasOwn(value,'value'))throw Error('Invalid failure response');text(value.error,4000,'response error');}
 }
 encodeFrame(value);return value;
}
function createFrameParser(onFrame,{multiple=false}={}){
 if(typeof onFrame!=='function')throw Error('Frame callback required');
 let pending=Buffer.alloc(0),count=0,total=0,failed=false;
 const feed=chunk=>{
  if(failed)throw Error('Bridge parser is closed after an error');
  try{
   if(!Buffer.isBuffer(chunk)&&!(chunk instanceof Uint8Array))throw Error('Bridge input must be bytes');
   if(!multiple&&count&&chunk.length)throw Error('Unexpected additional bridge frame');
   total+=chunk.length;if(total>(multiple?1024*1024:MAX_FRAME_BYTES))throw Error('Bridge input exceeds limit');
   pending=Buffer.concat([pending,chunk]);
   for(;;){
    const newline=pending.indexOf(10);if(newline<0)break;
    if(newline+1>MAX_FRAME_BYTES)throw Error('Bridge frame exceeds limit');
    if(++count>(multiple?1000:1))throw Error('Too many bridge frames');
    const frame=pending.subarray(0,newline);pending=pending.subarray(newline+1);
    if(!multiple&&pending.length)throw Error('Unexpected trailing bridge data');
    const decoded=new TextDecoder('utf-8',{fatal:true}).decode(frame);
    if(!decoded.length)throw Error('Empty bridge frame');onFrame(JSON.parse(decoded));
   }
   if(pending.length>=MAX_FRAME_BYTES)throw Error('Bridge frame exceeds limit');
  }catch(error){failed=true;throw error;}
 };
 feed.finish=()=>{if(failed||pending.length||!count)throw Error('Incomplete bridge response');};
 Object.defineProperty(feed,'done',{get:()=>count>0&&!pending.length&&!failed});
 return feed;
}
module.exports={PROTOCOL,MAX_FRAME_BYTES,MAX_PACKAGE_BYTES,MAX_TOTAL_BYTES,MAX_PACKAGES,bridgeRoot,validateDescriptor,validateRequest,validatePackage,validateResponse,jobDirectory,packagePath,sameToken,encodeFrame,createFrameParser};

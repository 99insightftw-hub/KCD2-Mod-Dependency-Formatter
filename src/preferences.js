'use strict';
// Convenience settings only. Failed or unsafe preferences never block a scan.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const MAX_BYTES=16384,fields=['gameRoot','downloadFolder'];
const empty=()=>({gameRoot:null,downloadFolder:null});
function folder(value){
 if(value===null)return null;
 if(typeof value!=='string'||!value||value.length>4096||/[\x00-\x1f]/.test(value)||!path.isAbsolute(value))throw Error('Invalid saved folder');
 if(process.platform==='win32'&&(/^[\\/]{2}[?.]/.test(value)||value.slice(2).includes(':')))throw Error('Invalid saved folder');
 return path.resolve(value);
}
function normalize(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1)throw Error('Unsupported preferences');
 const result=empty();for(const field of fields)if(value[field]!==undefined)result[field]=folder(value[field]);return result;
}
async function plain(target,{file=false}={}){
 const resolved=path.resolve(target);for(let p=resolved;;p=path.dirname(p)){
  const s=await fs.lstat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(s&&(s.isSymbolicLink()||(p===resolved&&file?(!s.isFile()||s.nlink!==1):!s.isDirectory())))throw Error('Unsafe preferences path');
  if(path.dirname(p)===p)break;
 }
}
function createPreferences(directory){
 const root=path.resolve(directory),file=path.join(root,'preferences.json');let queue=Promise.resolve();
 async function read(){
  try{
   await plain(file,{file:true});const before=await fs.lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(!before)return empty();
   if(before.size>MAX_BYTES)throw Error('Preferences exceed read limit');
   const handle=await fs.open(file,'r');let raw;
   try{const opened=await handle.stat();if(opened.ino!==before.ino||opened.dev!==before.dev||opened.nlink!==1||!opened.isFile())throw Error('Preferences changed');const buffer=Buffer.alloc(MAX_BYTES+1),{bytesRead}=await handle.read(buffer,0,buffer.length,0);if(bytesRead>MAX_BYTES)throw Error('Preferences exceed read limit');raw=buffer.subarray(0,bytesRead).toString('utf8');}finally{await handle.close();}
   await plain(file,{file:true});return normalize(JSON.parse(raw.replace(/^\uFEFF/,'')));
  }catch{return {...empty(),warning:'Saved folders could not be read. Choose your game or downloads folder again.'};}
 }
 async function save(patch){
  let temp;
  try{
   if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!fields.includes(k)))throw Error('Invalid preference update');
   const values={};for(const field of fields)if(Object.hasOwn(patch,field))values[field]=folder(patch[field]);
   await plain(root);await plain(file,{file:true});const previous=await read(),next={version:1,...empty()};for(const field of fields)next[field]=Object.hasOwn(values,field)?values[field]:previous[field];
   await fs.mkdir(root,{recursive:true});await plain(root);temp=path.join(root,'preferences-'+crypto.randomBytes(12).toString('hex')+'.tmp');
   await fs.writeFile(temp,JSON.stringify(next,null,2)+'\n',{flag:'wx',mode:0o600});await plain(file,{file:true});await plain(root);await fs.rename(temp,file);temp=null;return {saved:true};
  }catch{return {saved:false,warning:'This selection works for this session, but could not be saved for next time.'};}
  finally{if(temp)await fs.unlink(temp).catch(()=>{});}
 }
 return {file,read,update(patch){const operation=queue.then(()=>save(patch));queue=operation.catch(()=>{});return operation;}};
}
module.exports={createPreferences};

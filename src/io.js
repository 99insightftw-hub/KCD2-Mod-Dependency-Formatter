'use strict';
const fs=require('fs/promises'),path=require('path'),crypto=require('crypto'),yauzl=require('yauzl');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
async function hashFile(file) {
  const h=crypto.createHash('sha256');
  const fh=await fs.open(file,'r');
  try{const buf=Buffer.alloc(1024*1024);let n;while((n=(await fh.read(buf,0,buf.length,null)).bytesRead))h.update(buf.subarray(0,n));}
  finally{await fh.close();}return h.digest('hex');
}
function safeRelative(name) {
  const n=String(name).replace(/\\/g,'/');
  if(!n||n.startsWith('/')||/[\x00-\x1f:*?"<>|]/.test(n))throw Error('Unsafe file path: '+name);
  const parts=n.replace(/\/$/,'').split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw Error('Unsafe file path: '+name);
  return parts.join('/');
}
async function zipInspect(file,{read=()=>false,maxEntries=50000,maxReadBytes=12*1024*1024,maxEntryBytes=1024*1024,check=()=>{},onProgress=()=>{}}={}) {
  return new Promise((resolve,reject)=>yauzl.open(file,{lazyEntries:true,decodeStrings:true,validateEntrySizes:true},(error,zip)=>{
    if(error)return reject(error);const entries=[],contents=new Map(),seen=new Set();let bytes=0,finished=false;
    function fail(e){if(finished)return;finished=true;zip.close();reject(e);}
    zip.on('error',fail);zip.on('end',()=>{if(!finished){finished=true;resolve({entries,contents});}});
    zip.on('entry',async e=>{
      try {
        check();onProgress('Reading archive entry '+(entries.length+1));
        const name=safeRelative(e.fileName),key=name.toLowerCase();
        if(seen.has(key))throw Error('Duplicate archive path: '+name);seen.add(key);
        if(entries.length>=maxEntries)throw Error('Archive file-count limit reached.');
        const mode=e.externalFileAttributes>>>16;
        if((mode&0xf000)===0xa000)throw Error('Archive contains a symbolic link: '+name);
        const directory=e.fileName.endsWith('/');entries.push({name,size:e.uncompressedSize,directory});
        if(directory||!read(name,e)){zip.readEntry();return;}
        if(e.uncompressedSize>maxEntryBytes||(bytes+=e.uncompressedSize)>maxReadBytes)throw Error('Archive read limit reached.');
        zip.openReadStream(e,(error,stream)=>{
          if(error)return fail(error);const chunks=[];let actual=0;
          stream.on('error',fail);stream.on('data',chunk=>{try{check();actual+=chunk.length;if(actual>maxEntryBytes)stream.destroy(Error('Entry read limit reached.'));else chunks.push(chunk);}catch(e){stream.destroy(e);}});
          stream.on('end',()=>{if(finished)return;const content=Buffer.concat(chunks);if(crc32(content)!==e.crc32)return fail(Error('CRC mismatch: '+name));contents.set(name,content);zip.readEntry();});
        });
      }catch(error){fail(error);}
    });zip.readEntry();
  }));
}
async function boundedWalk(root,{maxDepth=4,maxFiles=3000}={}) {
  const result=[],errors=[];let count=0;
  async function walk(dir,depth,ancestors) {
    let real;
    try{real=await fs.realpath(dir);}catch(e){errors.push({path:dir,error:e.message});return;}
    const key=real.toLowerCase();if(ancestors.has(key)){errors.push({path:dir,error:'Folder link loop'});return;}
    const next=new Set(ancestors);next.add(key);
    let list;try{list=await fs.readdir(dir,{withFileTypes:true});}catch(e){errors.push({path:dir,error:e.message});return;}
    for(const e of list) {
      if(++count>maxFiles)throw Error('Folder scan limit reached: '+root);
      const file=path.join(dir,e.name);let s=e;
      if(e.isSymbolicLink())try{s=await fs.stat(file);}catch(error){errors.push({path:file,error:'Broken link: '+error.message});continue;}
      if(s.isDirectory()){if(depth<maxDepth)await walk(file,depth+1,next);}
      else if(s.isFile())result.push(file);
    }
  }
  await walk(root,0,new Set());return {files:result,errors};
}
async function nativeInfo(file) {
  const fh=await fs.open(file,'r');
  try {
    const {size}=await fh.stat();const b=Buffer.alloc(Math.min(size,4096));await fh.read(b,0,b.length,0);
    if(b.length<64||b.readUInt16LE(0)!==0x5a4d)return {valid:false,reason:'Not a Windows PE binary'};
    const pe=b.readUInt32LE(60);if(pe>size-26)return {valid:false,reason:'Invalid PE header offset'};
    const header=Buffer.alloc(26);await fh.read(header,0,26,pe);
    if(header.readUInt32LE(0)!==0x4550)return {valid:false,reason:'Invalid PE signature'};
    const machine=header.readUInt16LE(4),magic=header.readUInt16LE(24),timestamp=header.readUInt32LE(8);
    return {valid:true,machine,architecture:machine===0x8664&&magic===0x20b?'x64':machine===0x14c?'x86':'other',timestamp,size};
  }finally{await fh.close();}
}
module.exports={hash,hashFile,safeRelative,zipInspect,boundedWalk,nativeInfo,crc32};

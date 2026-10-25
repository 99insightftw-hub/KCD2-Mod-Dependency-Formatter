'use strict';
const fs=require('fs/promises'),path=require('path'),crypto=require('crypto');
// Explicit author repositories and end-user assets, not forks/source archives.
const sources={
 kcdutils:{repo:'Destuur/KCDUtils',asset:/^kcdutils\.zip$/i},
 luadb:{repo:'muyuanjin/kcd2db',asset:/^kcd2db-v[\d.]+\.zip$/i},
 asi:{repo:'ThirteenAG/Ultimate-ASI-Loader',asset:/^Ultimate-ASI-Loader(?:-NoPDB)?_x64\.zip$/i}
};
const MAX=100*1024*1024;
function safeUrl(url){const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.port||!['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(u.hostname))throw Error('Download redirect is not an allowed GitHub host.');return u;}
async function response(url,signal,fetcher=fetch){
 for(let i=0;i<6;i++){
  safeUrl(url);const r=await fetcher(url,{signal,redirect:'manual',headers:{'User-Agent':'KCD2-Dependency-Checker','Accept':'application/vnd.github+json'}});
  if([301,302,303,307,308].includes(r.status)){await r.body?.cancel();const next=r.headers.get('location');if(!next)throw Error('Missing download redirect.');url=new URL(next,url).href;continue;}
  if(!r.ok){await r.body?.cancel();throw Error(`GitHub returned HTTP ${r.status}. Use the author page if access is unavailable or rate-limited.`);}return r;
 }throw Error('Too many download redirects.');
}
async function bytes(r,limit){let size=0;const chunks=[];for await(const chunk of r.body){size+=chunk.length;if(size>limit)throw Error('GitHub response exceeds the size limit.');chunks.push(chunk);}return Buffer.concat(chunks);}
function selectAssets(id,releases){
 const s=sources[id];if(!s)throw Error('This dependency requires its author download page.');if(!Array.isArray(releases))throw Error('Invalid GitHub release response.');
 const result=[];
 for(const r of releases){if(r.draft||r.prerelease||typeof r.tag_name!=='string')continue;
  for(const a of r.assets||[]){if(!s.asset.test(a.name||'')||!Number.isSafeInteger(a.size)||a.size<=0||a.size>MAX||!/^sha256:[a-f0-9]{64}$/i.test(a.digest||''))continue;
   const prefix=`https://github.com/${s.repo}/releases/download/`;if(typeof a.browser_download_url!=='string'||!a.browser_download_url.startsWith(prefix))continue;
   safeUrl(a.browser_download_url);result.push({dependency:id,repo:s.repo,version:r.tag_name,name:a.name,size:a.size,sha256:a.digest.slice(7).toLowerCase(),url:a.browser_download_url});
  }
 }return result.slice(0,10);
}
async function releases(id,signal,fetcher=fetch){const s=sources[id];if(!s)throw Error('This dependency requires its author download page.');const r=await response(`https://api.github.com/repos/${s.repo}/releases?per_page=10`,signal,fetcher);return selectAssets(id,JSON.parse((await bytes(r,2*1024*1024)).toString('utf8')));}
async function download(asset,root,{signal,progress=()=>{},fetcher=fetch}={}){
 // Revalidate even main-process choices; never accept arbitrary destinations.
 const approved=selectAssets(asset.dependency,[{tag_name:asset.version,assets:[{name:asset.name,size:asset.size,digest:'sha256:'+asset.sha256,browser_download_url:asset.url}]}]);
 if(approved.length!==1)throw Error('Invalid release asset.');
 await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(path.join(root,'github-')),partial=path.join(dir,asset.name+'.partial'),file=path.join(dir,asset.name);
 let handle;try{
  const r=await response(asset.url,signal,fetcher),length=r.headers.get('content-length');if(length&&Number(length)!==asset.size)throw Error('Release size has changed.');
  handle=await fs.open(partial,'wx');let size=0;const h=crypto.createHash('sha256');
  for await(const chunk of r.body){signal?.throwIfAborted();size+=chunk.length;if(size>asset.size||size>MAX)throw Error('Download exceeds the declared size.');h.update(chunk);await handle.writeFile(chunk);progress(`Downloading ${asset.name}: ${Math.round(size/asset.size*100)}%`);}
  if(size!==asset.size||h.digest('hex')!==asset.sha256)throw Error('Release size/SHA-256 verification failed.');await handle.close();handle=null;await fs.rename(partial,file);
  await fs.writeFile(path.join(dir,'download-receipt.json'),JSON.stringify({source:asset.url,repository:asset.repo,version:asset.version,sha256:asset.sha256,bytes:size,time:new Date().toISOString(),claim:'Author asset integrity only; game compatibility unproven.'},null,2),{flag:'wx'});return file;
 }catch(e){await handle?.close();await fs.unlink(partial).catch(()=>{});throw e;}
}
module.exports={sources,safeUrl,selectAssets,releases,download};

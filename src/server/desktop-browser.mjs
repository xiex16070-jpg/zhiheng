import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ID_RE} from './auth.mjs';
import {resolveHost} from './netguard.mjs';

const run=promisify(execFile);
export const DESKTOP_OPEN_SCHEMA={type:'function',function:{name:'desktop_open_url',
  description:'在本机默认浏览器中打开用户指定的公开网站。是真实桌面窗口，不是隔离浏览器；仅确认操作系统接受打开请求，不读取登录态、页面内容或控制鼠标。须本机设置启用且按具体URL审批。',
  parameters:{type:'object',additionalProperties:false,properties:{url:{type:'string',minLength:1,maxLength:1500,description:'完整http或https网址，例如https://www.bilibili.com/'}},required:['url']}}};

export async function validateDesktopUrl(raw,{resolve=resolveHost}={}) {
  if(typeof raw!=='string'||raw.length>1500||/[\x00-\x20\x7f]/.test(raw))throw new Error('desktop_url_invalid');
  let url;try{url=new URL(raw);}catch{throw new Error('desktop_url_invalid');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.port&&!['80','443'].includes(url.port))throw new Error('desktop_url_invalid');
  const result=await resolve(url.hostname,{allowLoopback:false});
  if(!result.ok)throw new Error('desktop_public_url_required');
  return url.href;
}
async function launchWindowsUrl(url,{signal}={}) {
  // Fixed script + an environment value: never interpolate model text into shell code.
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const script="$ErrorActionPreference='Stop'; Start-Process -FilePath $env:ZHIHENG_DESKTOP_URL -ErrorAction Stop | Out-Null; [Console]::Write('dispatched')";
  const result=await run(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{
    windowsHide:true,shell:false,signal,timeout:10000,maxBuffer:16384,env:{...process.env,ZHIHENG_DESKTOP_URL:url}});
  if(result.stdout.trim()!=='dispatched')throw new Error('desktop_dispatch_unconfirmed');
}
export async function openDesktopUrl(args,ctx,{launch=launchWindowsUrl,resolve=resolveHost,platform=process.platform}={}) {
  if(ctx.desktopAllowed!==true||ctx.runtimeSettings?.desktopEnabled!==true||!ID_RE.test(String(ctx.userId||''))||!ID_RE.test(String(ctx.taskId||'')))throw new Error('desktop_local_session_required：须在本机设置中启用桌面浏览器。');
  if(ctx.subagentDepth||ctx.backgroundDepth)throw new Error('desktop_foreground_required：桌面操作须由前台主任务发起。');
  if(platform!=='win32')throw new Error('desktop_platform_unavailable：当前只支持Windows默认浏览器。');
  if(ctx.approvalVerified!==true)throw new Error('desktop_approval_required：请先确认本次具体网址。');
  ctx.signal?.throwIfAborted();
  const url=await validateDesktopUrl(args.url,{resolve});
  await launch(url,{signal:ctx.signal});
  return {text:`已请求本机默认浏览器打开 ${url}。操作系统已接受请求；尚未观察网页加载结果，不代表已控制或读取该页面。`,summary:'已请求本机浏览器打开网站',evidence:[],
    operation:{kind:'desktop_open_url',status:'requested',url,verified:false}};
}

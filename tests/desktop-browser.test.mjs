import test from 'node:test';
import assert from 'node:assert/strict';
import {openDesktopUrl,validateDesktopUrl} from '../src/server/desktop-browser.mjs';
import {searchToolSchemas,resolveLazyToolCall} from '../src/server/lazy-tools.mjs';
import {DESKTOP_OPEN_SCHEMA} from '../src/server/desktop-browser.mjs';

const publicHost=async()=>({ok:true,ips:['93.184.216.34']});
const context={userId:'owner',taskId:'task',desktopAllowed:true,runtimeSettings:{desktopEnabled:true},approvalVerified:true};
test('desktop launch requires trusted foreground local metadata, enablement and exact operation approval',async()=>{
  let launches=0;const options={platform:'win32',resolve:publicHost,launch:async url=>{launches++;assert.equal(url,'https://www.bilibili.com/');}};
  for(const patch of [{desktopAllowed:false},{runtimeSettings:{desktopEnabled:false}},{approvalVerified:false},{subagentDepth:1},{backgroundDepth:1},{userId:'../other'},{taskId:''}]) {
    await assert.rejects(openDesktopUrl({url:'https://www.bilibili.com/'},{...context,...patch},options));
  }
  assert.equal(launches,0);
  const result=await openDesktopUrl({url:'https://www.bilibili.com/'},context,options);
  assert.equal(launches,1);assert.equal(result.operation.status,'requested');assert.equal(result.operation.verified,false);assert.match(result.text,/尚未观察网页加载/);
  for(const platform of ['linux','darwin'])await assert.rejects(openDesktopUrl({url:'https://www.bilibili.com/'},context,{...options,platform}),/platform_unavailable/);
  assert.equal(launches,1,'unsupported platforms must reject before invoking a native launcher');
});
test('desktop URLs reject local/private destinations, files, custom protocols, credentials and control characters',async()=>{
  for(const url of ['file:///C:/Windows','javascript:alert(1)','ms-settings:','https://user:password@example.org','https://example.org:9000','https://example.org/\ncommand'])await assert.rejects(validateDesktopUrl(url,{resolve:publicHost}));
  await assert.rejects(validateDesktopUrl('http://127.0.0.1/',{resolve:async()=>({ok:false})}),/public_url_required/);
  const literal='https://example.org/?q=$(whoami)';let captured;
  await openDesktopUrl({url:literal},context,{platform:'win32',resolve:publicHost,launch:async url=>{captured=url;}});
  assert.equal(captured,literal);
});
test('desktop discovery searches only authorized catalogs and does not invent a GUI control capability',()=>{
  const other={type:'function',function:{name:'read_file',description:'读取文件'}};
  assert.equal(searchToolSchemas([DESKTOP_OPEN_SCHEMA,other],'在本电脑打开网站')[0].function.name,'desktop_open_url');
  assert.deepEqual(searchToolSchemas([other],'在本电脑打开网站'),[]);
  assert.throws(()=>resolveLazyToolCall({name:'tool_call',arguments:{name:'desktop_open_url',arguments:{url:'https://www.bilibili.com/'}}},[other],new Set(['desktop_open_url'])));
});

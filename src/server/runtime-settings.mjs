import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { ID_RE } from './auth.mjs';
import { withFileLock, writeJsonAtomic } from './fsutil.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const fail = code => Object.assign(new Error(code), { code });
const defaults = () => ({ revision: 0, execEnabled: config.exec.enabled, sessionEnabled: process.env.EXEC_SESSIONS === '1', desktopEnabled: false,
  latexEnginePath: process.env.LATEX_ENGINE_PATH || '', contextBudget: config.context.tokenBudget,
  compactRatio: config.context.compactRatio, keepTail: config.context.keepTail, microKeepRecent: config.context.microKeepRecent });
const bounds = { contextBudget: [2048,1048576], keepTail:[4,40], microKeepRecent:[1,20] };
function filename(uid) {
  if (!ID_RE.test(String(uid || ''))) throw fail('invalid_user');
  return path.join(config.dataDir,'runtime-settings',uid+'.json');
}
function validate(row) {
  if (!row || Object.keys(row).some(k => !Object.hasOwn(defaults(), k)) || !Number.isSafeInteger(row.revision) || row.revision < 0) throw fail('invalid_runtime_settings');
  for (const key of ['execEnabled','sessionEnabled','desktopEnabled']) if (typeof row[key] !== 'boolean') throw fail('invalid_runtime_settings');
  for (const [key,[min,max]] of Object.entries(bounds)) if (!Number.isSafeInteger(row[key]) || row[key] < min || row[key] > max) throw fail('invalid_runtime_settings');
  if (!Number.isFinite(row.compactRatio) || row.compactRatio < .5 || row.compactRatio > .9) throw fail('invalid_runtime_settings');
  if (typeof row.latexEnginePath !== 'string' || row.latexEnginePath.length > 500 || /[\x00-\x1f]/.test(row.latexEnginePath) || row.latexEnginePath && (!path.isAbsolute(row.latexEnginePath) || !/^tectonic(?:\.exe)?$/i.test(path.basename(row.latexEnginePath)))) throw fail('invalid_latex_path');
  return row;
}
/** Per-user local configuration. No global process.env changes or cross-user grants. */
export function getRuntimeSettings(uid) {
  if (!uid) return defaults();
  try {
    const raw = fs.readFileSync(filename(uid),'utf8'); if (raw.length > 10000) throw fail('runtime_settings_unreadable');
    return validate(JSON.parse(raw));
  } catch (error) { if (error.code === 'ENOENT') return defaults(); throw fail('runtime_settings_unreadable'); }
}
export async function saveRuntimeSettings(uid, input) {
  validate(input);
  return withFileLock(filename(uid),async()=>{
    const prior = getRuntimeSettings(uid); if (input.revision !== prior.revision) throw fail('runtime_settings_conflict');
    const next = { ...input, revision: prior.revision+1 };
    await writeJsonAtomic(filename(uid),next,{mode:0o600}); return next;
  });
}

export async function testRuntimeSettings(uid,input){
  if(!input||!['commands','latex'].includes(input.kind)||Object.keys(input).some(k=>!['kind','latexEnginePath'].includes(k)))throw fail('invalid_runtime_test');
  const run=promisify(execFile);
  if(input.kind==='commands'){
    const {stdout}=await run(process.execPath,['--version'],{windowsHide:true,timeout:5000,maxBuffer:10000});
    const enabled=getRuntimeSettings(uid).execEnabled;
    return {ok:true,message:`Node ${stdout.trim()} 可调用。命令执行${enabled?'已开启':'尚未开启'}，保存配置后生效。`};
  }
  const engine=String(input.latexEnginePath||getRuntimeSettings(uid).latexEnginePath||'');
  validate({...getRuntimeSettings(uid),latexEnginePath:engine});
  if(!engine)return {ok:false,message:'请填写 Tectonic 可执行文件的绝对路径；此机器尚未配置离线排版引擎。'};
  let stat;try{stat=fs.lstatSync(engine);}catch{return {ok:false,message:'该路径没有可执行文件，请检查路径。'};}
  if(!stat.isFile()||stat.isSymbolicLink())return {ok:false,message:'请选择普通的 Tectonic 可执行文件。'};
  try{const {stdout}=await run(engine,['--version'],{windowsHide:true,timeout:5000,maxBuffer:10000});return {ok:/tectonic/i.test(stdout),message:/tectonic/i.test(stdout)?`${stdout.trim().slice(0,160)} · 引擎可启动；离线包是否齐备需通过实际编译验证。`:'程序未返回预期的 Tectonic 版本信息。'};}
  catch{return {ok:false,message:'引擎未能在5秒内启动，请核对安装与可执行文件。'};}
}

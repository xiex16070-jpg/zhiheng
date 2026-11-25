import {parseProgram} from '../logic/hanlogic.mjs';
import {LOGIC_GROUNDED_SCHEMA} from './logic-tool.mjs';

export function detectLogicIntent(question) {
  const text=String(question||'');
  if(/(?:^|\n)\s*(?:事实|规则|查询)\s+/.test(text))return {detected:false,reason:'explicit_program'};
  const conditional=/若[\s\S]{1,300}则|如果[\s\S]{1,300}(?:那么|则|就)|只有[\s\S]{1,300}才|除非|规则链/.test(text);
  const questionLike=/能否|是否|能不能|可否|推出|成立[吗么？?]|推理|推断|判断|规则链|结论|冲突|矛盾/.test(text);
  const introductory=/^(?:请)?(?:介绍|解释|什么是|如何理解)/.test(text.trim())&&!/(?:已知|假设|给定|事实|规则如下)/.test(text);
  return {detected:conditional&&questionLike&&!introductory,reason:conditional&&questionLike&&!introductory?'conditional_rules':'ordinary_task'};
}
export const LOGIC_PROPOSAL_SCHEMA={type:'function',function:{name:'propose_logic_program',description:'把自然语言条件规则转换为知衡程序供用户确认；先验证语法，不执行。用户可修订程序，批准后按四值规则执行。程序真实性和自然语言映射须由用户核对，不把形式可运行当作事实已证实。',
  parameters:{type:'object',additionalProperties:false,properties:{program:LOGIC_GROUNDED_SCHEMA.function.parameters.properties.program,
    mode:{type:'string',enum:['assumptions','grounded']},bindings:LOGIC_GROUNDED_SCHEMA.function.parameters.properties.bindings,
    explanation:{type:'string',maxLength:1000,description:'简短说明中文条件方向、隐含假设和需要确认的映射；不要填推理思维过程。'}},required:['program','mode']}}};
export function prepareLogicProposal(args) {
  if(!args||typeof args.program!=='string'||!args.program.trim()||args.program.length>20000||!['assumptions','grounded'].includes(args.mode))throw Object.assign(new Error('请提供不超过20000字符的程序以及assumptions/grounded模式。'),{code:'logic_proposal_invalid'});
  const parsed=parseProgram(args.program);
  if(!parsed.queries.length)throw Object.assign(new Error('请至少写出一个需要验证的查询。'),{code:'logic_query_required'});
  if(args.mode==='grounded'&&!Array.isArray(args.bindings))throw Object.assign(new Error('有据模式需要逐条引文绑定。'),{code:'logic_bindings_required'});
  return {program:args.program,mode:args.mode,explanation:String(args.explanation||'').slice(0,1000),facts:parsed.facts.length,rules:parsed.rules.length,queries:parsed.queries.length,
    warning:'确认的是条件、事实和符号映射。执行结果只相对于该程序成立；未知不等于否定。'};
}
export const logicRoutingPrompt='本次检测到自然语言条件规则问题。请走“形式化 → 用户确认 → 执行 → 解释”：先用propose_logic_program提交事实、方向明确的规则和查询，简短说明映射；不得提前执行或把草案当作已证明。若只是用户给定假设请选择assumptions；文献真实性结论请选择grounded并逐条绑定来源引文。只有A才B表示B推出A，不自动添加逆命题。用户拒绝后停止此轮形式化；缺少前提时可以说明缺口。';

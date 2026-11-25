const kinds=['support','inference'];
/** A separate, durable two-request allowance; never changes answer context usage. */
export function createJudgeBudget({state={},calls,persist}) {
  calls.judge=Math.max(Number(calls.judge)||0,kinds.filter(kind=>state[kind]?.reserved).length);
  return {
    async reserve(kind) {
      if(!kinds.includes(kind)||state[kind]?.reserved||calls.judge>=2)return false;
      state[kind]={reserved:true,usage:null};calls.judge++;
      // No network call is allowed until this reservation has reached storage.
      await persist();return true;
    },
    async record(kind,report) {
      if(!kinds.includes(kind)||!state[kind]?.reserved||!report?.llmCalls)return;
      state[kind].usage=report.usage||null;state[kind].returned=true;await persist();
    },
    usage(){return Object.fromEntries(kinds.map(kind=>[kind,{calls:state[kind]?.reserved?1:0,usage:state[kind]?.usage||null,...(state[kind]?.reserved&&!state[kind].returned?{uncertain:true}:{})}]));},
  };
}

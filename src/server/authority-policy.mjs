// An allowlist is a discovery policy, not a certificate of truth or peer review.
// Explicit hosts prevent look-alike domains and arbitrary .gov / github.com content.
const groups = [
  ['official', '政府与公共机构', ['gov.cn', 'stats.gov.cn', 'miit.gov.cn', 'census.gov', 'fda.gov', 'cdc.gov', 'sec.gov', 'congress.gov', 'nist.gov', 'uspto.gov']],
  ['official', '国际组织', ['who.int', 'un.org', 'unesco.org', 'worldbank.org', 'imf.org', 'oecd.org', 'ipcc.ch', 'epo.org']],
  ['academic', '学术出版', ['nature.com', 'science.org', 'thelancet.com', 'ieeexplore.ieee.org', 'dl.acm.org', 'sciencedirect.com', 'jstor.org', 'aclanthology.org']],
  ['academic', '学术文献', ['pubmed.ncbi.nlm.nih.gov', 'pmc.ncbi.nlm.nih.gov', 'europepmc.org', 'cnki.net', 'wanfangdata.com.cn', 'ncpssd.cn']],
  ['technical', '技术文档与标准', ['developer.mozilla.org', 'docs.python.org', 'python.org', 'react.dev', 'go.dev', 'w3.org', 'ietf.org', 'rfc-editor.org', 'iso.org']],
  ['reference', '研究型参考资料', ['plato.stanford.edu', 'britannica.com', 'ourworldindata.org']],
  ['news', '新闻与事实核查', ['reuters.com', 'apnews.com', 'bbc.com', 'ft.com', 'economist.com', 'factcheck.org', 'politifact.com', 'snopes.com', 'fullfact.org', 'factcheck.afp.com']],
  ['preprint', '预印本', ['arxiv.org', 'biorxiv.org', 'medrxiv.org']],
];
export const AUTHORITY_CATALOG = groups.map(([type, label, domains]) => ({ type, label, domains }));
const permittedTypes = {
  mixed: new Set(groups.map(g => g[0])),
  academic: new Set(['academic', 'preprint']),
  official: new Set(['official']),
  technical: new Set(['technical', 'academic', 'preprint']),
};
export function authorityUrl(raw, { focus = 'mixed', includePreprints = true } = {}) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    for (const group of AUTHORITY_CATALOG) {
      if (!permittedTypes[focus]?.has(group.type) || (!includePreprints && group.type === 'preprint')) continue;
      const domain = group.domains.find(d => host === d || host.endsWith('.' + d));
      if (domain) return { type: group.type, label: group.label, domain, url: url.href };
    }
  } catch { /* Not a public source URL. */ }
  return null;
}
export function authorityDomains(options) {
  return AUTHORITY_CATALOG.flatMap(g => g.domains).filter(domain => authorityUrl('https://' + domain, options));
}

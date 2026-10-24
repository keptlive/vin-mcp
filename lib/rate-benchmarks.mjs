// Manually verified against the official G.19 release, not a live quote feed.
export function rateBenchmarks() {
  const release='2026-10-07';
  return {
    available:true,kind:'dated_public_benchmark_snapshot',currency:'USD',
    source:{provider:'Federal Reserve Board, G.19 Consumer Credit',url:'https://www.federalreserve.gov/releases/g19/20261007/',release_date:release,verified_at:'2026-10-24',observation_period:'2026-08'},
    stale:Date.now()-Date.parse(release)>120*86400000,
    data:[{term_months:60,apr_percent:7.54},{term_months:72,apr_percent:7.17}],
    scope:'US commercial-bank new-car loan benchmarks; not used-car rates, lender offers or individual eligibility',
    method:'Unweighted averages of surveyed banks’ most common rates during the survey week. Observations are not seasonally adjusted.',
    update_policy:'Manually verified snapshot, not automatically refreshed. Check the current release before using it as current market context.',
    current_release_url:'https://www.federalreserve.gov/releases/g19/current/default.htm'
  };
}

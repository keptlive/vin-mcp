/* The shared shell joins VIN reports, public research and personal vehicle lists. */
(() => {
  const q = selector => document.querySelector(selector);
  const titles = {report:'VIN report',compare:'Compare vehicles',catalog:'Specifications',communications:'Safety records',costs:'Ownership costs',saved:'Saved & recent vehicles',coverage:'Data coverage',developers:'Developer tools'};
  const aliases = {'mcp-info':'developers','history':'saved','saved-vins':'saved'};
  let report = null, toolDirectoryLoaded = false, toolDirectoryPending = false;
  const selected = () => aliases[location.hash.slice(1)] || (titles[location.hash.slice(1)] ? location.hash.slice(1) : 'report');
  q('.skip-link').addEventListener('click', event => { event.preventDefault(); q('#main').focus(); });
  function syncRoute() {
    const id = selected();
    document.querySelectorAll('#main > section').forEach(section => section.hidden = section.id !== id);
    document.querySelectorAll('#workspace-navigation a').forEach(link => { if (link.hash === '#'+id) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current'); });
    q('#menu-current').textContent = titles[id];
    q('#menu-toggle').setAttribute('aria-expanded','false');
    q('.workspace-sidebar').classList.remove('menu-open');
    q('#my-vins-btn').setAttribute('aria-pressed',String(id === 'saved'));
    q('#user-menu').open = false;
    q('#print-view').hidden = id === 'saved';
    document.title = titles[id] + ' | mcp.vin';
    if (id === 'developers') loadToolDirectory();
  }
  function navigate(id) {
    if (!titles[id]) return;
    if (location.hash !== '#'+id) location.hash = id;
    syncRoute();
  }
  q('#menu-toggle').addEventListener('click', () => {
    const open = q('.workspace-sidebar').classList.toggle('menu-open');
    q('#menu-toggle').setAttribute('aria-expanded',String(open));
  });
  document.querySelectorAll('#workspace-navigation a').forEach(link => link.addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(link.hash.slice(1));
    const heading = q('#'+selected()+' h1');
    if (heading) { heading.tabIndex = -1; heading.focus({preventScroll:true}); }
  }));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { q('.workspace-sidebar').classList.remove('menu-open'); q('#menu-toggle').setAttribute('aria-expanded','false'); q('#user-menu').open = false; }
  });
  document.addEventListener('click', event => {
    if (!q('#user-menu').contains(event.target)) q('#user-menu').open = false;
  });
  function reportUpdated(data) {
    report = data;
    q('#report-welcome').hidden = true;
    q('#vehicle-context').hidden = false;
    q('#context-title').textContent = [data.vehicle.year,data.vehicle.make,data.vehicle.model].filter(Boolean).join(' ');
    q('#context-vin').textContent = data.vin;
    q('#hero h1').textContent = 'Vehicle report';
  }
  function clearReport() {
    report = null;
    q('#results').hidden = true;
    q('#report-welcome').hidden = false;
    q('#vehicle-context').hidden = true;
    q('#save-vin-btn').hidden = true;
  }
  function addComparison(vin) {
    const field = q('#vins');
    const vins = field.value.trim().toUpperCase().split(/[\s,;]+/).filter(Boolean);
    if (!vins.includes(vin)) {
      if (vins.length >= 4) { navigate('compare'); q('#compare-context').textContent = 'The comparison already has four vehicles. Remove one to add '+vin+'.'; field.focus(); return; }
      vins.push(vin); field.value = vins.join('\n'); field.dispatchEvent(new Event('input',{bubbles:true}));
    }
    q('#compare-context').textContent = vin + ' is in your comparison. Add another VIN or generate the report.';
    navigate('compare'); field.focus();
  }
  q('#compare-current').addEventListener('click', () => { if (report) addComparison(report.vin); });
  q('#research-model-link').addEventListener('click', () => {
    if (!report) return;
    for (const key of ['year','make','model']) q('#bulletin-form [name='+key+']').value = report.vehicle[key] || '';
    q('#bulletin-form').dispatchEvent(new Event('input',{bubbles:true}));
    q('#evidence-context').textContent = 'Searching model-year evidence for '+q('#context-title').textContent+'. These records are not VIN-specific repair history.';
    q('#evidence-context').hidden = false;
    navigate('communications');
  });
  q('#cost-current').addEventListener('click', () => {
    if (!report) return;
    const fuel = report.fuel_economy;
    const form = q('#cost-form');
    let copied = false;
    // MPGe cannot be used as kWh/100mi. Never silently substitute those units.
    if (fuel?.available && !fuel.is_ev && Number(fuel.combined_mpg) > 0) {
      form.querySelector('[name=energy_type]').value = 'gas';
      form.querySelector('[name=energy_type]').dispatchEvent(new Event('change',{bubbles:true}));
      form.querySelector('[name=efficiency]').value = fuel.combined_mpg;
      form.dispatchEvent(new Event('input',{bubbles:true}));
      copied = true;
    }
    q('#cost-context').textContent = q('#context-title').textContent + ' · ' + (copied ? 'Combined EPA MPG has been copied from the matched configuration. Verify the configuration and all other assumptions before calculating.' : 'Enter the matching energy type and efficiency, along with your purchase and operating assumptions. No efficiency value was copied.');
    q('#cost-context').hidden = false;
    navigate('costs');
  });
  async function loadToolDirectory() {
    if (toolDirectoryLoaded || toolDirectoryPending) return;
    toolDirectoryPending = true;
    const target = q('#tool-directory'); target.textContent = 'Loading the server’s tool directory…';
    try {
      const response = await fetch('/api/tools',{cache:'no-store'});
      if (!response.ok) throw new Error('HTTP '+response.status);
      const data = await response.json(); target.replaceChildren();
      for (const group of data.groups) {
        const block = document.createElement('section'); block.className = 'tool-group';
        const title = document.createElement('h4'); title.textContent = group.name + ' · ' + group.tools.length + ' tools'; block.append(title);
        const list = document.createElement('div'); list.className = 'tool-list';
        for (const tool of group.tools) {
          const entry = document.createElement('div'); entry.className = 'tool-entry';
          const name = document.createElement('code'); name.textContent = tool.name;
          const description = document.createElement('p'); description.textContent = tool.description;
          entry.append(name,description); list.append(entry);
        }
        block.append(list); target.append(block);
      }
      toolDirectoryLoaded = true;
    } catch (error) {
      target.textContent = 'Tool directory unavailable: '+error.message+'. ';
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'secondary'; retry.textContent = 'Try again'; retry.onclick = loadToolDirectory; target.append(retry);
    } finally { toolDirectoryPending = false; }
  }
  function canPrint(id) {
    if (id === 'report' && (!report || q('#results').hidden || report.vin !== q('#vin-input').value.trim().toUpperCase())) { clearReport(); q('#decode-status').textContent = 'Load a report for the entered VIN before printing.'; q('#print-meta').textContent = 'mcp.vin | No current report for the entered VIN.'; q('#vin-input').focus(); return false; }
    return id !== 'saved';
  }
  window.VinWorkspace = {selected,syncRoute,navigate,reportUpdated,clearReport,addComparison,canPrint};
  addEventListener('hashchange',syncRoute);
  syncRoute();
})();

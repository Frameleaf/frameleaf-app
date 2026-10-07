import { createSetup, advanceSetup, readiness, linkDemoPhone, setupStatusResponse } from './setup-status.mjs';
import { encodeQr, qrPath } from './qr.mjs';

// This module models the shared Manager/mobile journey in one browser tab.
// No real account, email, server pairing, API request, or mobile sync occurs.
export function createOnboardingUI({ state, go, render, icon, esc, button, badge, heading, section, listRow, notice, steps, modal, toast }) {
  let timer;
  let phoneStage = 'welcome';
  let platform = 'ios';
  let accountChoice = 'local';
  let accountVerified = false;
  const profile = { firstName: 'Alex', lastName: 'Morgan', email: 'alex@example.test' };
  const apps = {
    ios: { name: 'iPhone & iPad', label: 'iOS', url: 'https://frameleaf.app/apps/iphone/', screenshot: 'ios-library-months.avif', availability: 'Coming soon to the App Store', alt: 'Official Frameleaf Months library screenshot on iPhone' },
    android: { name: 'Android', label: 'Android', url: 'https://frameleaf.app/apps/android/', screenshot: 'android-library-all.avif', availability: 'Coming soon to Google Play', alt: 'Official Frameleaf library screenshot on Android' },
  };
  const setupSteps = current => steps(['Server ready', 'Your details', 'Get the app', 'Finish setup'], current);
  const counts = () => state.installOrigin === 'install' ? { assets: 0, albums: 0 } : state.source === 'test' ? { assets: 512, albums: 8 } : { assets: 18240, albums: 94 };
  const number = n => Math.round(n).toLocaleString('en-US');
  const progress = (label, pct) => `<div class="spread progress-label"><span>${label}</span><strong>${pct}%</strong></div><div class="progress" role="progressbar" aria-label="${label}" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>`;
  const qr = url => { const code = encodeQr(url); return `<svg class="download-qr" viewBox="0 0 ${code.size + 8} ${code.size + 8}" role="img" aria-label="QR code for ${esc(url)}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path d="${qrPath(code.modules)}" fill="#101416"/></svg>`; };
  const kindLabel = () => state.setup.kind === 'new_import' ? 'New Immich import' : state.setup.kind === 'restored_library' ? 'Restored library' : 'New library';
  const phaseLabel = () => state.setup.error ? 'Needs your attention' : state.setup.phase === 'complete' ? 'Library ready' : state.setup.paused ? 'Rescan paused' : state.setup.phase === 'verifying' ? 'Checking your library' : 'Rescanning your library';
  const initials = () => esc((profile.firstName[0] || 'A') + (profile.lastName[0] || 'M'));

  function redrawProgress() {
    if (state.view !== 'phone' || !['sync', 'library'].includes(phoneStage)) return;
    const scroller = document.querySelector('.page-scroll');
    const top = scroller?.scrollTop || 0;
    const activeAction = document.activeElement?.dataset?.action;
    render();
    document.querySelector('.page-scroll').scrollTop = top;
    if (activeAction) [...document.querySelectorAll('[data-action]')].find(el => el.dataset.action === activeAction)?.focus({ preventScroll: true });
  }
  function tick() {
    clearTimeout(timer);
    if (!state.setup || readiness(state.setup).canFinish) return;
    timer = setTimeout(() => { advanceSetup(state.setup); redrawProgress(); tick(); }, 1800);
  }
  function start(origin) {
    clearTimeout(timer);
    state.setup = createSetup(origin);
    phoneStage = 'welcome'; platform = 'ios'; accountChoice = 'local'; accountVerified = false;
    Object.assign(profile, { firstName: 'Alex', lastName: 'Morgan', email: 'alex@example.test' });
    tick();
  }
  function reset() { clearTimeout(timer); state.setup = null; phoneStage = 'welcome'; accountVerified = false; }
  function preview() {
    state.installed = true; state.running = true; state.source = 'family'; state.installOrigin = 'import'; state.sourceStopped = true;
    start('import'); go('profile');
  }
  function completionView() {
    const imported = state.installOrigin === 'import';
    return setupSteps(0) + heading(imported ? 'Your import is in Frameleaf' : 'Your server is ready', 'Now make it yours and connect your phone. Library preparation continues while you finish setup.') +
      notice('Services are ready', imported ? 'Your users, albums and settings are imported. Immich remains stopped, and your media stays in place.' : 'Your photo server is running. Continue with your profile and mobile app.', 'good', 'check') +
      `<div class="mt16">${section('Finishing in the background', listRow('update', phaseLabel(), 'Rescan media locations, reconcile the catalog, and verify library access.', badge('Preparing')) + listRow('user', 'Your details & optional Frameleaf account', 'Keep your local photo account. Add a Frameleaf account if you want one.') + listRow('image', 'Your library, ready on your phone', 'Connect the app while the server works. Catalog sync begins as soon as you sign in.'))}</div>` +
      `<div class="wizard-footer"><span class="sample-note">Prototype · No real installation was changed</span>${button('Continue to your details', 'onboarding-profile', 'primary', 'arrow')}</div>`;
  }
  function profileView() {
    return setupSteps(1) + heading('Make yourself at home', 'Confirm your details, then decide whether to add a Frameleaf account.') +
      `<form id="profile-form" class="card"><div class="card-body"><div class="profile-intro"><span class="profile-avatar">${initials()}</span><div><h2>Your photo profile</h2><p class="meta">${state.installOrigin === 'import' ? 'Your imported account and library permissions are preserved.' : 'Your local photo account belongs to this server.'}</p></div></div><div class="form-grid mt24"><label class="field"><span>First name</span><input name="firstName" data-profile="firstName" value="${esc(profile.firstName)}" autocomplete="off" maxlength="80" required></label><label class="field"><span>Last name</span><input name="lastName" data-profile="lastName" value="${esc(profile.lastName)}" autocomplete="off" maxlength="80" required></label><label class="field full"><span>Email address</span><input name="email" data-profile="email" type="email" value="${esc(profile.email)}" autocomplete="off" required><small>Use sample details in this prototype. Nothing is sent or stored outside this tab.</small></label></div></div></form>` +
      `<div class="mt24">${section('A Frameleaf account is optional', `<div class="card-body"><p class="muted account-description">One sign-in for Frameleaf services. You can choose Cloud features later; creating an account does not start a subscription.</p><div class="stack mt16">${[['local', 'Continue with my local account', 'Use Frameleaf on your own server. You can add an account later.'], ['create', 'Create a Frameleaf account', 'Connect this profile to a new Frameleaf account.'], ['existing', 'I already have a Frameleaf account', 'Sign in and link your existing account.']].map(([value,title,description])=>`<label class="radio-card"><input type="radio" name="frameleaf-account" value="${value}" ${accountChoice===value?'checked':''}><div><strong>${title}</strong><p>${description}</p></div></label>`).join('')}</div></div>`, badge('Optional'))}</div>` +
      `<div class="wizard-footer">${button('Back', 'onboarding-profile-back', 'quiet')}${button(accountChoice === 'local' ? 'Continue without an account' : accountChoice === 'create' ? 'Create account & continue' : 'Sign in & continue', 'onboarding-profile-save', 'primary')}</div>`;
  }
  function verifyView() {
    return setupSteps(1) + heading('Confirm your Frameleaf account', 'Your local photo account stays connected to this server.') +
      section('Check your email', `<div class="card-body"><p>In the finished product, Frameleaf sign-in opens a secure account verification flow for <strong>${esc(profile.email)}</strong>.</p><form id="verification-form" class="stack mt24"><label class="field"><span>Sample verification code</span><input id="verification-code" inputmode="numeric" pattern="246810" maxlength="6" placeholder="246810" autocomplete="off" required><small>Enter 246810 to preview a verified account. No email was sent.</small></label></form><p class="meta mt16">This prototype does not create an account, collect a password, accept terms, or start a subscription.</p></div>`) +
      `<div class="wizard-footer">${button('Back', 'onboarding-profile', 'quiet')}${button('Verify sample account', 'onboarding-verify', 'primary')}</div>`;
  }
  function downloadCard(key) {
    const app = apps[key];
    return `<section class="card download-card"><div class="card-header"><h2>${app.name}</h2>${badge(app.label)}</div><div class="download-art"><img class="official-app-shot" src="assets/${app.screenshot}" alt="${app.alt}" width="120" height="260"><div class="qr-column"><a href="${app.url}" target="_blank" rel="noopener noreferrer" aria-label="Open official ${app.name} app page">${qr(app.url)}</a><span class="meta">Scan with your phone</span></div></div><div class="card-body"><p class="availability">${app.availability}</p><a class="button quiet app-page-link" href="${app.url}" target="_blank" rel="noopener noreferrer">Open ${app.label} app page ${icon('arrow')}</a></div></section>`;
  }
  function downloadsView() {
    return setupSteps(2) + heading('Your whole library. In your pocket.', 'Get Frameleaf on your phone, then link the server you just set up.') +
      `<div class="notice good mb16">${icon(accountVerified?'check':'user')}<div><strong>${accountVerified?'Frameleaf account linked':'Your local account is ready'}</strong><p>${esc(profile.firstName)} · ${esc(profile.email)}${accountVerified?' · Sample verification complete':' · No Frameleaf account required'}</p></div></div><div class="two-cols download-grid">${downloadCard('ios')}${downloadCard('android')}</div>` +
      `<p class="asset-credit">Screenshots and availability from <a href="https://frameleaf.app/apps" target="_blank" rel="noopener noreferrer">frameleaf.app</a>. QR codes open the official app pages while the store releases are coming soon.</p>` +
      `<div class="mt24">${section('Link your home server', `<div class="card-body"><ol class="connection-steps"><li><span>1</span><p>Connect your phone to the same network as your server.</p></li><li><span>2</span><p>Open Frameleaf and choose <strong>Home library</strong>, or enter the server address below.</p></li><li><span>3</span><p>${state.installOrigin === 'import'?'Sign in with your imported photo account.':'Sign in to your local photo account.'} Your library starts syncing immediately.</p></li></ol><div class="server-address"><div><small>Server address</small><code>https://home-server:2283</code></div>${button('Copy', 'onboarding-copy-address', 'quiet')}</div><p class="meta mt16">New servers can be claimed with their one-time setup code. Imported servers require the existing account; linking never grants new library permissions.</p></div>`)}</div>` +
      `<div class="wizard-footer">${button('Back', 'onboarding-profile', 'quiet')}<div class="actions">${button('Preview phone setup', 'onboarding-phone', 'primary', 'arrow')}</div></div>`;
  }
  function serverPanel() {
    const setup = state.setup, ready = readiness(setup), count = counts();
    return `<section class="card server-preparation"><div class="card-header"><h2>On your server</h2>${badge(ready.serverReady?'Ready':kindLabel(),ready.serverReady?'good':'')}</div><div class="card-body">${progress(phaseLabel(),setup.progress)}<ol class="timeline mt16">${[
      ['Database & settings', 'Imported accounts and permissions preserved', true],
      ['Rescan media locations', 'Check originals, derivatives and external libraries', setup.rescanComplete],
      ['Verify library', 'Reconcile albums, file access and the final catalog', setup.verificationPassed],
      ['Prepare this phone', 'Sync its catalog, search index and browsing previews', ready.phoneReady],
    ].map(([title,description,done])=>`<li class="${done?'done':''}"><span class="stage-icon">${icon(done?'check':'clock')}</span><div><strong>${title}</strong><p>${description}</p></div></li>`).join('')}</ol>${setup.error?notice('Preparation needs attention','The sample connection was interrupted. Reconnect to resume from the same progress.','warning','warning'):notice(ready.canFinish?'Setup complete. You’re ready to go.':ready.serverReady?(setup.mobile.linked?'Server ready. Finishing your phone.':'Server ready. Connect your phone.'):'Preparing your library together',ready.canFinish?`${number(count.assets)} photos and videos available to your account. The server and phone are up to date.`:ready.serverReady?(setup.mobile.linked?'The phone is catching up with the completed rescan. Finish unlocks when its catalog and previews are ready.':'Sign in on the phone to begin syncing its library. Both screens will confirm when it is ready.'):'Keep the app open for the fastest first sync. If your phone pauses background work, syncing resumes when you reopen it.',ready.canFinish?'good':'','info')}</div><div class="card-footer"><span class="meta">${state.setup.managerFinished?'Manager setup complete':ready.canFinish?'Safe to finish':'Setup in progress'}</span>${button('Finish setup', 'onboarding-finish-manager', 'primary', '',ready.canFinish?'':'disabled')}</div></section>`;
  }
  function mobileBody() {
    const setup = state.setup, ready = readiness(setup), count = counts();
    if(phoneStage === 'library') return `<div class="phone-finished"><span class="phone-check">${icon('check')}</span><h3>Ready when you are.</h3><p>Your library is already here.</p></div><img class="phone-library-screenshot" src="assets/${apps[platform].screenshot}" alt="${apps[platform].alt}"><p class="phone-caption">Official app screenshot · Sample library</p>`;
    if(phoneStage === 'welcome') return `<div class="phone-welcome"><img src="assets/frameleaf-app-icon.svg" alt="Frameleaf" width="66" height="66"><h3>Welcome home.</h3><p>Your photos are waiting on your own server. Let’s bring them to your phone.</p></div><div class="phone-server"><span class="phone-icon">${icon('server')}</span><div><strong>Home library</strong><small>Found on your network</small></div></div><div class="phone-callout">${badge('Setup in progress')}<p>Sign in to see library preparation and start syncing your photos, albums and search.</p></div>${button('Connect to Home library','onboarding-connect','primary phone-primary')}<button class="text-button phone-help" data-action="onboarding-address">Enter a server address</button>`;
    if(phoneStage === 'signin') return `<div class="phone-heading"><span class="phone-icon">${icon('lock')}</span><h3>${state.installOrigin==='import'?'Your familiar sign-in.':'Sign in to your library.'}</h3><p>${state.installOrigin==='import'?'Use your imported photo account. Your albums and permissions come with you.':'Use the local photo account for this server.'}</p></div><div class="phone-user"><span class="profile-avatar">${initials()}</span><div><strong>${esc(profile.firstName)} ${esc(profile.lastName)}</strong><small>${esc(profile.email)}</small></div></div><p class="phone-copy">${accountVerified?'Your linked Frameleaf identity still requires access to this local library.':'No Frameleaf Cloud account is needed to connect at home.'}</p>${button('Sign in with sample account','onboarding-authenticate','primary phone-primary')}<p class="phone-caption">Demo authentication · No credentials needed</p>`;
    const pct = setup.mobile.progress;
    return `<div class="phone-import-label">${badge(kindLabel())}</div><div class="phone-heading"><span class="phone-icon ${ready.phoneReady?'ready':''}">${icon(ready.phoneReady?'check':'update')}</span><h3>${ready.phoneReady?'Your library is ready.':'Making room for memories.'}</h3><p>${ready.phoneReady?'Everything is in place for your first look.':'We’re preparing your library while your server finishes setup.'}</p></div><div class="phone-sync-panel">${progress(ready.phoneReady?'Library synced':setup.error?'Sync interrupted':setup.paused?'Sync paused':'Syncing library data',pct)}<div class="phone-sync-count"><strong>${number(count.assets*pct/100)}</strong><span>of ${number(count.assets)} photos & videos</span></div><ul class="phone-checks"><li>${icon(pct>=55?'check':'clock')}Dates, locations & photo details</li><li>${icon(pct>=75?'check':'clock')}Albums, permissions & search</li><li>${icon(ready.phoneReady?'check':'clock')}Thumbnails & latest scan changes</li></ul></div><div class="phone-server-status"><span class="status-dot"></span><strong>${ready.serverReady?'Server rescan complete':phaseLabel()}</strong><span>${setup.progress}%</span></div><p class="phone-copy">${ready.phoneReady?'Your catalog and browsing previews are up to date. Original photos stay on your server.':'Catalog and preview sync continues during setup. You won’t arrive at an empty library.'}</p>${button(ready.phoneReady?'Finish & open library':'Preparing your library…','onboarding-finish-phone','primary phone-primary','',ready.phoneReady?'':'disabled')}${setup.error||setup.paused?button(setup.error?'Reconnect & resume':'Resume sync','onboarding-resume','quiet phone-primary'):''}`;
  }
  function phoneView() {
    return setupSteps(3) + heading(readiness(state.setup).canFinish?'Ready on your server. Ready on your phone.':'Your library is taking shape.', 'Follow preparation on Manager and in the app. Both stay in step as your imported library becomes ready.') +
      `<div class="setup-layout"><div>${serverPanel()}<div class="prototype-controls"><span class="eyebrow">Prototype controls</span><div class="row wrap">${button(state.setup.paused?'Resume preparation':'Pause preparation',state.setup.paused?'onboarding-resume':'onboarding-pause','quiet')}${button('Complete preparation','onboarding-complete','quiet')}${button('Preview interruption','onboarding-interrupt','quiet')}${button('View status contract','onboarding-api','quiet')}</div><p class="sample-note mt8">Accelerated sample progress · No server or phone is connected.</p></div></div><section class="mobile-preview" aria-label="Mobile app first-time setup"><div class="phone-preview-label"><span>Mobile app preview</span><div class="segmented">${['ios','android'].map(key=>`<button data-action="onboarding-platform:${key}" aria-pressed="${platform===key}">${apps[key].label}</button>`).join('')}</div></div><div class="phone-device ${platform==='android'?'android':''}"><div class="phone-top"><img src="assets/frameleaf-logo-white.svg" alt="Frameleaf" width="98"><span>Home library</span></div><div class="phone-content">${mobileBody()}</div><div class="phone-home-indicator"></div></div></section></div><div class="wizard-footer">${button('Back to app downloads','onboarding-downloads','quiet')}<span class="sample-note">Your progress continues while you explore.</span></div>`;
  }
  function finishedView() {
    return setupSteps(4) + `<div class="success-head"><div class="success-icon">${icon('check')}</div><h1 tabindex="-1">Welcome to your Frameleaf library.</h1><p>Your server has finished its rescan. Your phone’s library is synced and ready for its first look.</p></div>` +
      section('Setup complete', listRow('check','Library rescanned & verified','Original media locations and user permissions preserved',badge('Complete','good'))+listRow('check','Your phone is ready',`${number(counts().assets)} photos and videos · Catalog, albums, search and browsing previews synced`,badge('Ready','good'))+listRow('user',accountVerified?'Frameleaf account linked':'Using your local account',`${esc(profile.firstName)} ${esc(profile.lastName)} · ${esc(profile.email)}`,badge(accountVerified?'Linked':'Local'))) +
      `<div class="wizard-footer">${button('View phone preview','onboarding-phone','quiet')}${button('Finish & view overview','nav:overview','primary')}</div>`;
  }
  function summaryBanner() {
    if(!state.setup || state.setup.managerFinished) return '';
    return `<div class="notice ${readiness(state.setup).canFinish?'good':''} mb16">${icon('update')}<div class="grow"><strong>${readiness(state.setup).canFinish?'Setup is ready to finish':'Finish setting up your library'}</strong><p>${phaseLabel()} · Phone ${state.setup.mobile.linked?'connected':'not connected yet'}</p></div>${button('Continue setup',state.setup.mobile.linked?'onboarding-phone':'onboarding-profile','quiet')}</div>`;
  }
  function showContract() {
    modal('Shared setup status · Proposed API', `<p>This is the proposed authenticated server response, simulated locally. Manager and mobile read the same setup session. No live API endpoint is implemented by this prototype.</p><pre class="log">${esc(JSON.stringify(setupStatusResponse(state.setup,{authenticated:true}),null,2))}</pre><p>The phone starts its existing library sync after authentication, scoped to that user. It applies updates, permission changes and removals through the final library revision, then reports catalog and preview readiness. Both Finish controls use that state.</p><p>Before sign-in, discovery only exposes whether setup is required. Cloud sign-in and paid features remain optional.</p>`,button('Done','close-modal','primary'));
  }
  function handle(action) {
    if(!action.startsWith('onboarding-')) return false;
    if(action==='onboarding-preview') {preview();return true;}
    if(!state.setup) start(state.installOrigin||'import');
    if(action==='onboarding-profile')go('profile');
    if(action==='onboarding-profile-back')go('success');
    if(action==='onboarding-profile-save') {
      const form=document.querySelector('#profile-form');if(!form.reportValidity())return true;
      go(accountChoice==='local'?'downloads':'verify-account');
    }
    if(action==='onboarding-verify') {if(!document.querySelector('#verification-form').reportValidity())return true;accountVerified=true;go('downloads');}
    if(action==='onboarding-downloads')go('downloads');
    if(action==='onboarding-phone')go('phone');
    if(action==='onboarding-connect'){phoneStage='signin';go('phone');}
    if(action==='onboarding-authenticate'){linkDemoPhone(state.setup);phoneStage='sync';tick();go('phone');}
    if(action==='onboarding-copy-address')navigator.clipboard?.writeText('https://home-server:2283').then(()=>toast('Sample server address copied.')).catch(()=>toast('Server address: https://home-server:2283'));
    if(action==='onboarding-address')modal('Connect to your server','<p>In the app, enter your local server address and sign in to your photo account.</p><p class="mono">https://home-server:2283</p><p>This is a sample address for the prototype.</p>',button('Use sample server','onboarding-use-address','primary'));
    if(action==='onboarding-use-address'){document.querySelector('#dialog').close();phoneStage='signin';go('phone');}
    if(action.startsWith('onboarding-platform:')){platform=action.split(':')[1];render();}
    if(action==='onboarding-pause'){state.setup.paused=true;render();}
    if(action==='onboarding-resume'){state.setup.paused=false;state.setup.error=null;tick();render();}
    if(action==='onboarding-interrupt'){state.setup.error='demo_connection_lost';render();}
    if(action==='onboarding-complete'){
      state.setup.paused=false;state.setup.error=null;
      for(let i=0;i<25;i++)advanceSetup(state.setup);
      render();
      if(!state.setup.mobile.linked)toast('Server ready. Connect the sample phone to start its own library sync.');
    }
    if(action==='onboarding-finish-phone'&&readiness(state.setup).phoneReady){state.setup.mobile.finished=true;phoneStage='library';go('phone');}
    if(action==='onboarding-finish-manager'&&readiness(state.setup).canFinish){state.setup.managerFinished=true;go('setup-complete');}
    if(action==='onboarding-api')showContract();
    return true;
  }
  document.addEventListener('input',event=>{const key=event.target.dataset.profile;if(key&&Object.hasOwn(profile,key)){profile[key]=event.target.value;accountVerified=false;}});
  document.addEventListener('change',event=>{if(event.target.name==='frameleaf-account'){accountChoice=event.target.value;accountVerified=false;render();}});
  document.addEventListener('submit',event=>{if(['profile-form','verification-form'].includes(event.target.id)){event.preventDefault();handle(event.target.id==='profile-form'?'onboarding-profile-save':'onboarding-verify');}});
  return { start, reset, preview, handle, completionView, summaryBanner, showContract, views:{profile:profileView,'verify-account':verifyView,downloads:downloadsView,phone:phoneView,'setup-complete':finishedView} };
}

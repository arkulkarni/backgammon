/* Backgammon <-> Firebase Firestore sync, with required email/password sign-in.
 *
 * WHAT: Email/password sign-in is REQUIRED to use the app. On first launch the
 * user creates an account (or signs in); the session persists, so it is a
 * one-time step per browser. Finished games save to the signed-in user's
 * private Firestore collection users/{uid}/games, so one account = one shared
 * history across all devices and browsers. Email/password was chosen over
 * Google OAuth because Google blocks OAuth inside iOS home-screen web apps
 * (disallowed_useragent); the email flow is pure API calls and works
 * everywhere. Games saved earlier under an anonymous id are migrated into the
 * account on first sign-in.
 *
 * Past Games (menu + setup screen) merges cloud games newest-first with any
 * unsaved session entries. Tapping a cloud entry opens Game Review replay.
 *
 * HOW IT IS WIRED IN: this file is inlined verbatim into a <script> block just
 * before </body> of the deployed index.html (see INTEGRATION.md). It does NOT
 * modify backgammon.html. It monkey-patches at load:
 *   - window.endGame           -> after a game ends, queue a Firestore save
 *   - window.pastGamesListHtml -> render cloud games + unsaved session games
 *   - window.openMenu          -> append a SIGN OUT button
 * plus one delegated document click listener for [data-cloudgame] buttons,
 * plus a full-screen login gate overlay shown until sign-in completes.
 *
 * FAILURE MODE: anything Firebase-related that fails before sign-in keeps the
 * login gate up with a plain-language error for another attempt.
 * After sign-in, Firestore failures are silent: session-only history, no UI,
 * no popups, at most one console.warn.
 */
(function(){
'use strict';
if(window.__bgFirebaseSyncLoaded)return;
window.__bgFirebaseSyncLoaded=true;

/* ---------------- config ---------------- */
var FB_SDK_VER='10.14.1';
var FB_CONFIG={
  apiKey:"AIzaSyBwsNb0nfuF4udrtc1-hb-2t3d4UxjLNSc",
  authDomain:"backgammon-52682.firebaseapp.com",
  projectId:"backgammon-52682",
  storageBucket:"backgammon-52682.firebasestorage.app",
  messagingSenderId:"652678845411",
  appId:"1:652678845411:web:4bb276b711efcbbe96c6d6"
};

var warned=false;
function warnOnce(msg){
  if(warned)return;warned=true;
  try{console.warn('[bg-firebase-sync] '+msg);}catch(e){}
}

var state={ready:false,uid:null,db:null,auth:null,pendingMigration:[],gateShown:false};

/* ---------------- game hooks (installed synchronously, always safe) ---------------- */
function hookGame(){
  try{
    if(typeof GAME==='undefined'||!GAME)return false;
    if(!GAME.cloudGames)GAME.cloudGames=[];

    var origEnd=window.endGame;
    if(typeof origEnd==='function'&&!origEnd.__bgWrapped){
      var wEnd=function(winner){
        var r=origEnd.apply(this,arguments);
        try{onGameEnded();}catch(e){}
        return r;
      };
      wEnd.__bgWrapped=true;
      window.endGame=wEnd;
    }

    var origList=window.pastGamesListHtml;
    if(typeof origList==='function'&&!origList.__bgWrapped){
      var wList=function(){
        try{return mergedPastGamesListHtml();}catch(e){return origList();}
      };
      wList.__bgWrapped=true;
      wList.__bgOrig=origList;
      window.pastGamesListHtml=wList;
    }

    var origMenu=window.openMenu;
    if(typeof origMenu==='function'&&!origMenu.__bgWrapped){
      var wMenu=function(){
        var r=origMenu.apply(this,arguments);
        try{addSignOut();}catch(e){}
        return r;
      };
      wMenu.__bgWrapped=true;
      window.openMenu=wMenu;
    }

    var origSetup=window.showSetup;
    if(typeof origSetup==='function'&&!origSetup.__bgWrapped){
      var wSetup=function(){
        var r=origSetup.apply(this,arguments);
        try{injectUserBar();}catch(e){}
        return r;
      };
      wSetup.__bgWrapped=true;
      window.showSetup=wSetup;
    }

    document.addEventListener('click',onDocClick);
    return true;
  }catch(e){return false;}
}

function onGameEnded(){
  if(!GAME.pastGames||!GAME.pastGames.length)return;
  var entry=GAME.pastGames[0];
  if(entry._syncId)return; // double-invocation guard
  entry._syncId='g'+Date.now().toString(36)+Math.random().toString(36).slice(2,10);
  saveGame(entry);
}

function onDocClick(ev){
  var t=ev&&ev.target&&ev.target.closest?ev.target.closest('[data-cloudgame]'):null;
  if(!t)return;
  var entry=(GAME.cloudGames||[])[Number(t.getAttribute('data-cloudgame'))];
  if(!entry||!entry.record)return;
  try{if(typeof Snd!=='undefined')Snd.btn();}catch(e){}
  try{openCloudGame(entry);}catch(e){}
}

/* Mirrors the game's own openArchivedGame, but reads from a cloud entry. */
function openCloudGame(entry){
  GAME.reviewReturn={
    state:GAME.state?cloneState(GAME.state):null,record:GAME.record,lastResult:GAME.lastResult,
    nameYou:GAME.nameYou,nameOpp:GAME.nameOpp,sideHuman:GAME.sideHuman,sideAI:GAME.sideAI,phase:GAME.phase,
    returnTo:GAME.phase==='setup'?'setup':'menu'
  };
  GAME.record=JSON.parse(JSON.stringify(entry.record));
  GAME.lastResult=JSON.parse(JSON.stringify(entry.lastResult));
  GAME.nameYou=entry.nameYou;GAME.nameOpp='Computer'; // opponent name is locked
  GAME.sideHuman=entry.sideHuman;GAME.sideAI=entry.sideAI;
  refreshIdentity();hideOverlay();
  var first=keyMoments()[0];
  showReplay(first?first.recordIndex:0,!!first);
}

/* Cloud entries first (newest first), then session entries not yet saved.
 * Renders the inner list for the dedicated Past Games screen (the screen
 * itself wraps this in <div class="pastGames">). When Firebase is down /
 * not loaded, GAME.cloudGames is empty and this delegates to the original
 * renderer, so output is pixel-identical. */
function mergedPastGamesListHtml(){
  var orig=window.pastGamesListHtml.__bgOrig;
  var cloud=GAME.cloudGames||[];
  if(!cloud.length)return orig();
  var cloudSync={};
  cloud.forEach(function(e){if(e.syncId)cloudSync[e.syncId]=1;});
  var cloudBtns=cloud.map(function(g,i){
    return '<button class="pastGameBtn" data-cloudgame="'+i+'"><b>'+escHtml(g.resultLabel)+' · '+g.scoreLabel+'</b><span>'+escHtml(g.dateLabel)+' · Open review</span></button>';
  });
  var sessionBtns=[];
  for(var i=0;i<GAME.pastGames.length;i++){
    var g=GAME.pastGames[i];
    if(g._syncId&&cloudSync[g._syncId])continue; // already shown in cloud list
    sessionBtns.push('<button class="pastGameBtn" data-past="'+i+'"><b>'+escHtml(g.resultLabel)+' · '+g.scoreLabel+'</b><span>'+escHtml(g.dateLabel)+' · Open review</span></button>');
  }
  var all=cloudBtns.concat(sessionBtns);
  if(!all.length)return orig();
  return all.join('');
}

/* ---------------- login gate ---------------- */
var GATE_CSS='position:fixed;inset:0;z-index:500;display:flex;align-items:center;justify-content:center;'
  +'background:radial-gradient(1300px 850px at 45% 30%,#2b1c12,#150d08);padding:20px;box-sizing:border-box;';

function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}

function authErrorMessage(err){
  var code=err&&err.code?String(err.code):'';
  if(code==='auth/operation-not-allowed')return'Email sign-in is not enabled for this app yet. Enable Email/Password in the Firebase console, then try again.';
  if(code==='auth/invalid-email')return'That email address doesn\u2019t look right.';
  if(code==='auth/user-not-found')return'No account found for that email. Tap \u201CCreate account\u201D below to make one.';
  if(code==='auth/wrong-password'||code==='auth/invalid-credential')return'Wrong email or password. Try again, or tap \u201CForgot password?\u201D.';
  if(code==='auth/email-already-in-use')return'That email already has an account. Sign in instead.';
  if(code==='auth/weak-password')return'Please choose a password with at least 6 characters.';
  if(code==='auth/too-many-requests')return'Too many attempts. Please wait a bit and try again.';
  if(code==='auth/network-request-failed')return'Could not reach the sign-in server. Check your connection and try again.';
  if(code==='auth/unauthorized-domain')return'This site is not authorized for sign-in. Add its domain under Authentication \u2192 Settings \u2192 Authorized domains.';
  return'Sign-in did not complete. Please try again.';
}

var emailMode='signin'; // or 'signup'

function showLoginGate(msg){
  var gate=document.getElementById('bgLoginGate');
  if(gate){
    var errEl=document.getElementById('bgLoginErr');
    if(errEl&&msg){errEl.textContent=msg;errEl.style.display='block';}
    return;
  }
  var d=document.createElement('div');
  d.id='bgLoginGate';
  d.setAttribute('style',GATE_CSS);
  var inputCss='display:block;width:100%;padding:13px 12px;margin:0 0 10px;border:1px solid #c9b98f;border-radius:10px;background:#fffdf6;font-size:16px;color:#3c3226;box-sizing:border-box;';
  d.innerHTML=
    '<div style="max-width:360px;width:100%;text-align:center;background:#f3e6c8;border-radius:16px;padding:28px 24px;box-shadow:0 18px 60px rgba(0,0,0,.6);box-sizing:border-box;">'
    +'<div style="font:800 30px Georgia,serif;color:#7a4a1e;letter-spacing:.06em;margin-bottom:6px;">BACKGAMMON</div>'
    +'<p style="color:#8a6f4d;font-size:13px;margin:0 0 18px;">Sign in to play.<br>Your games save to your account and follow you across devices.</p>'
    +'<input id="bgEmail" type="email" placeholder="Email" autocomplete="email" autocapitalize="none" spellcheck="false" style="'+inputCss+'">'
    +'<input id="bgPass" type="password" placeholder="Password" autocomplete="current-password" style="'+inputCss+'">'
    +'<button id="bgEmailBtn" style="display:block;width:100%;padding:13px;border:none;border-radius:10px;background:#7a4a1e;color:#fff8ea;font-size:16px;font-weight:700;cursor:pointer;">Sign In</button>'
    +'<p style="font-size:13px;margin:14px 0 0;color:#8a6f4d;"><a id="bgModeToggle" href="#" style="color:#7a4a1e;font-weight:700;text-decoration:none;">New here? Create account</a>'
    +' &nbsp;\u00B7&nbsp; <a id="bgForgot" href="#" style="color:#7a4a1e;text-decoration:none;">Forgot password?</a></p>'
    +'<p id="bgLoginErr" style="display:'+(msg?'block':'none')+';color:#a83226;font-size:12.5px;margin:12px 0 0;">'+esc(msg||'')+'</p>'
    +'<p style="color:#8a6f4d;font-size:10px;margin:10px 0 0;opacity:.55;">build 7</p>'
    +'</div>';
  document.body.appendChild(d);
  state.gateShown=true;
  var btn=document.getElementById('bgEmailBtn');
  var emailEl=document.getElementById('bgEmail');
  var passEl=document.getElementById('bgPass');
  var toggle=document.getElementById('bgModeToggle');
  var forgot=document.getElementById('bgForgot');
  function refreshMode(){
    btn.textContent=emailMode==='signup'?'Create Account':'Sign In';
    toggle.textContent=emailMode==='signup'?'Have an account? Sign in':'New here? Create account';
    if(passEl)passEl.setAttribute('autocomplete',emailMode==='signup'?'new-password':'current-password');
  }
  if(btn)btn.onclick=function(){startEmailAuth();};
  if(toggle)toggle.onclick=function(ev){if(ev&&ev.preventDefault)ev.preventDefault();emailMode=emailMode==='signup'?'signin':'signup';refreshMode();return false;};
  if(forgot)forgot.onclick=function(ev){if(ev&&ev.preventDefault)ev.preventDefault();forgotPassword();return false;};
  if(passEl)passEl.onkeydown=function(ev){if(ev&&(ev.key==='Enter'||ev.keyCode===13)){startEmailAuth();}};
  refreshMode();
  setTimeout(function(){try{if(emailEl)emailEl.focus();}catch(e){}},400);
}

function gateEmailPass(){
  var e=document.getElementById('bgEmail'),p=document.getElementById('bgPass');
  return {email:e?e.value.trim():'',pass:p?p.value:''};
}

function startEmailAuth(){
  var creds=gateEmailPass();
  if(!creds.email){showLoginGate('Please enter your email address.');return;}
  if(!creds.pass){showLoginGate('Please enter your password.');return;}
  if(emailMode==='signup'&&creds.pass.length<6){showLoginGate('Please choose a password with at least 6 characters.');return;}
  var btn=document.getElementById('bgEmailBtn');
  if(btn)btn.disabled=true;
  var done=function(){var b=document.getElementById('bgEmailBtn');if(b)b.disabled=false;};
  var op=emailMode==='signup'
    ?state.auth.createUserWithEmailAndPassword(creds.email,creds.pass)
    :state.auth.signInWithEmailAndPassword(creds.email,creds.pass);
  op.then(function(cred){
    if(cred&&cred.user)onSignedIn(cred.user);
    else done();
  },function(err){
    done();
    showLoginGate(authErrorMessage(err));
  });
}

function forgotPassword(){
  var creds=gateEmailPass();
  if(!creds.email){showLoginGate('Enter your email above first, then tap \u201CForgot password?\u201D.');return;}
  state.auth.sendPasswordResetEmail(creds.email).then(function(){
    showLoginGate('Password reset email sent. Check your inbox, then sign in with your new password.');
  },function(err){
    showLoginGate(authErrorMessage(err));
  });
}

function hideLoginGate(){
  var d=document.getElementById('bgLoginGate');
  if(d&&d.parentNode)d.parentNode.removeChild(d);
  state.gateShown=false;
}

/* Firestore Timestamps do not survive JSON; convert to millis and back. */
function serializeDocs(docs){
  return JSON.stringify(docs||[],function(k,v){
    if(v&&typeof v==='object'&&typeof v.toDate==='function'){
      return {__ts:v.toDate().getTime()};
    }
    return v;
  });
}
function deserializeDocs(s){
  if(!s)return [];
  try{
    return JSON.parse(s,function(k,v){
      if(v&&typeof v==='object'&&typeof v.__ts==='number'){
        return new firebase.firestore.Timestamp(Math.floor(v.__ts/1000),(v.__ts%1000)*1e6);
      }
      return v;
    });
  }catch(e){return [];}
}
function takeStashedMigration(){
  try{
    var s=sessionStorage.getItem('bgMig');
    sessionStorage.removeItem('bgMig');
    return deserializeDocs(s);
  }catch(e){return [];}
}

function doSignOut(){
  try{if(typeof Snd!=='undefined')Snd.btn();}catch(e){}
  if(state.auth)state.auth.signOut().then(function(){location.reload();},function(){location.reload();});
  else location.reload();
}

function addSignOut(){
  if(!(state.ready&&state.auth))return;
  if(!document.getElementById('mResume'))return; // only the real menu, not Past Games
  if(document.getElementById('bgSignOut'))return;
  var card=document.querySelector('.menuList');
  if(!card)return;
  var b=document.createElement('button');
  b.id='bgSignOut';b.className='pbtn';b.textContent='SIGN OUT';
  b.style.marginTop='10px';
  b.onclick=function(){doSignOut();};
  card.appendChild(b);
}

/* Signed-in email + sign-out on the setup screen (below the difficulty row). */
function injectUserBar(){
  if(!(state.ready&&state.auth))return;
  var body=document.querySelector('.setupBody');
  if(!body||document.getElementById('bgUserBar'))return;
  var email='';
  try{email=state.auth.currentUser&&state.auth.currentUser.email||'';}catch(e){}
  var bar=document.createElement('div');
  bar.id='bgUserBar';
  bar.style.cssText='margin:14px 0 0;font-size:12.5px;color:#8a6f4d;text-align:center;line-height:1.6;';
  bar.innerHTML='Signed in as <b>'+esc(email)+'</b><br><a href="#" id="bgSignOutSetup" style="color:#7a4a1e;font-weight:700;">Sign out</a>';
  body.appendChild(bar);
  var so=document.getElementById('bgSignOutSetup');
  if(so)so.onclick=function(ev){if(ev&&ev.preventDefault)ev.preventDefault();doSignOut();return false;};
}

/* ---------------- Firestore save / load ---------------- */
function num(n){return typeof n==='number'&&isFinite(n)?n:null;}

/* Firestore rejects nested arrays, and board states store points as an array
 * of 24 arrays. Pack states as JSON strings on save and unpack on load. */
function packState(s){try{return JSON.stringify(s);}catch(e){return null;}}
function packRecord(rec){
  if(!Array.isArray(rec))return [];
  return rec.map(function(t){
    return {side:t.side,dice:t.dice,moves:t.moves,analysis:t.analysis,
      before:packState(t.before),after:packState(t.after)};
  });
}
function packLastResult(lr){
  var c={};for(var k in lr){if(Object.prototype.hasOwnProperty.call(lr,k))c[k]=lr[k];}
  c.state=packState(lr.state);
  return c;
}
function unpackState(s){if(typeof s!=='string')return s;try{return JSON.parse(s);}catch(e){return null;}}
function unpackRecord(rec){
  if(!Array.isArray(rec))return rec;
  return rec.map(function(t){
    var c={};for(var k in t){if(Object.prototype.hasOwnProperty.call(t,k))c[k]=t[k];}
    c.before=unpackState(t.before);c.after=unpackState(t.after);
    return c;
  });
}
function unpackLastResult(lr){
  if(!lr||typeof lr!=='object')return lr;
  var c={};for(var k in lr){if(Object.prototype.hasOwnProperty.call(lr,k))c[k]=lr[k];}
  c.state=unpackState(lr.state);
  return c;
}

function buildDoc(entry){
  var lr=entry.lastResult||{};  var tierKey=null,tierLabel=null,tierElo=null;
  try{
    tierKey=GAME.difficulty||null;
    var tier=(typeof AI_TIERS!=='undefined')&&tierKey?AI_TIERS[tierKey]:null;
    if(tier){tierLabel=tier.label;tierElo=tier.elo;}
  }catch(e){}
  var acc=null;
  try{
    var pick=function(s){
      return s?{total:num(s.total),brilliant:s.brilliant,mistakes:s.mistakes,blunders:s.blunders,accuracy:s.accuracy}:null;
    };
    acc={you:pick(humanAnalysisSummary()),opp:pick(analysisSummary(GAME.sideAI))};
  }catch(e){acc=null;}
  return {
    syncId:entry._syncId,
    createdAt:firebase.firestore.FieldValue.serverTimestamp(),
    appVersion:2,
    result:entry.resultLabel,resultLabel:entry.resultLabel,scoreLabel:entry.scoreLabel,
    scores:{you:lr.you!=null?lr.you:null,opp:lr.opp!=null?lr.opp:null},
    points:lr.points!=null?lr.points:null,
    winner:lr.winner||null,matchOver:!!lr.matchOver,
    difficulty:tierKey,difficultyLabel:tierLabel,difficultyElo:tierElo,
    nameYou:entry.nameYou,nameOpp:entry.nameOpp,
    sideHuman:entry.sideHuman,sideAI:entry.sideAI,
    accuracy:acc,
    record:packRecord(entry.record),
    lastResult:packLastResult(lr),
    dateLabel:entry.dateLabel
  };
}

function cloudViewOf(entry,cloudId){
  return {
    cloudId:cloudId,syncId:entry._syncId,
    record:entry.record,lastResult:entry.lastResult,
    nameYou:entry.nameYou,nameOpp:entry.nameOpp,
    sideHuman:entry.sideHuman,sideAI:entry.sideAI,
    resultLabel:entry.resultLabel,scoreLabel:entry.scoreLabel,
    dateLabel:entry.dateLabel
  };
}

function saveGame(entry){
  if(!state.ready||!state.db||!state.uid)return;
  var doc;
  try{doc=buildDoc(entry);}catch(e){warnOnce('could not build save record');return;}
  try{
    state.db.collection('users').doc(state.uid).collection('games').add(doc).then(function(ref){
      entry._cloudId=ref.id;
      GAME.cloudGames.unshift(cloudViewOf(entry,ref.id));
    },function(){
      warnOnce('save failed; game kept for this session only');
    });
  }catch(e){warnOnce('save failed; game kept for this session only');}
}

function fmtDate(ts){
  try{
    var d=(ts&&typeof ts.toDate==='function')?ts.toDate():(ts instanceof Date?ts:null);
    if(!d)return '';
    return new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(d);
  }catch(e){return '';}
}

/* Raw game documents for a uid (used for both loading and migration). */
function readGameDocs(uid){
  return state.db.collection('users').doc(uid).collection('games')
    .orderBy('createdAt','desc').limit(50).get()
    .then(function(snap){
      var out=[];
      snap.forEach(function(doc){
        var d=doc.data()||{};
        if(!d.record||!d.lastResult)return;
        out.push(d);
      });
      return out;
    });
}

function docToView(docId,d){
  return {
    cloudId:docId,syncId:d.syncId||null,
    record:unpackRecord(d.record),lastResult:unpackLastResult(d.lastResult),
    nameYou:d.nameYou||'You',nameOpp:d.nameOpp||'Computer',
    sideHuman:d.sideHuman||'b',sideAI:d.sideAI||'w',
    resultLabel:d.resultLabel||'Game',scoreLabel:d.scoreLabel||'',
    dateLabel:d.dateLabel||fmtDate(d.createdAt)
  };
}

function loadCloudGames(){
  if(!state.ready||!state.db||!state.uid)return;
  readGameDocs(state.uid).then(function(docs){
    GAME.cloudGames=docs.map(function(d,i){return docToView('g'+i,d);});
  },function(){
    warnOnce('could not load cloud games; showing session history only');
  });
}

/* Copy games saved under the pre-login anonymous id into the signed-in account. */
function migrateAnonGames(docs){
  if(!docs.length)return Promise.resolve();
  var col=state.db.collection('users').doc(state.uid).collection('games');
  return Promise.all(docs.map(function(d){
    var copy={};
    for(var k in d){if(Object.prototype.hasOwnProperty.call(d,k))copy[k]=d[k];}
    copy.appVersion=2;
    copy.migratedFrom='anonymous';
    return col.add(copy);
  })).then(function(){},function(){warnOnce('some older games could not be carried over');});
}

/* ---------------- sign-in flow ---------------- */
function onSignedIn(user){
  if(!user||user.isAnonymous) return;
  if(state.ready&&state.uid===user.uid) return; // already in (observer + redirect both fire)
  state.uid=user.uid;
  state.ready=true;
  hideLoginGate();
  try{injectUserBar();}catch(e){}
  var mig=state.pendingMigration||[];
  state.pendingMigration=[];
  var stashed=takeStashedMigration();
  if(stashed.length) mig=mig.concat(stashed);
  // De-dupe by syncId: the same doc may be in both lists.
  var seen={},uniq=[];
  mig.forEach(function(d){var k=d&&d.syncId||null;if(k&&seen[k])return;if(k)seen[k]=1;uniq.push(d);});
  var done=function(){loadCloudGames();};
  if(uniq.length){
    migrateAnonGames(uniq).then(done,done);
  }else{
    done();
  }
}

function loadScript(src){
  return new Promise(function(res,rej){
    var s=document.createElement('script');
    s.src=src;s.async=true;
    s.onload=function(){res();};
    s.onerror=function(){rej(new Error('script load failed'));};
    document.head.appendChild(s);
  });
}

function boot(){
  var base='https://www.gstatic.com/firebasejs/'+FB_SDK_VER+'/';
  loadScript(base+'firebase-app-compat.js')
    .then(function(){return loadScript(base+'firebase-auth-compat.js');})
    .then(function(){return loadScript(base+'firebase-firestore-compat.js');})
    .then(function(){
      if(!window.firebase||!firebase.firestore||!firebase.auth)throw new Error('sdk incomplete');
      firebase.initializeApp(FB_CONFIG);
      state.auth=firebase.auth();
      state.db=firebase.firestore();
      // Sign-in detector: fires on restored sessions and cross-tab sign-ins.
      try{
        state.auth.onAuthStateChanged(function(u){
          if(u&&!u.isAnonymous) onSignedIn(u);
        });
      }catch(e){}
      // Show the gate promptly unless a session is already restoring.
      setTimeout(function(){ if(!state.ready) showLoginGate(); },600);
      // Once the observer has had a chance to report a restored session, look
      // for migratable pre-login games. Best effort: the anonymous provider may
      // be disabled, in which case this skips.
      setTimeout(function(){
        if(state.ready) return;
        var u=null; try{ u=state.auth.currentUser; }catch(e){}
        if(u&&!u.isAnonymous){ onSignedIn(u); return; }
        state.auth.signInAnonymously().then(function(cred){
          return readGameDocs(cred.user.uid);
        }).then(function(docs){
          state.pendingMigration=docs;
        }).catch(function(){
          state.pendingMigration=[];
        });
      },1500);
    })
    .then(null,function(){
      // SDK scripts failed to load (offline etc.)
      try{ showLoginGate('Could not load sign-in. Check your connection, then reload the page.'); }
      catch(e){ warnOnce('auth unavailable'); }
    });
}

/* ---------------- go ---------------- */
if(hookGame()){boot();}
})();

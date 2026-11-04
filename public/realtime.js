(function (root) {
  'use strict';
  function mount(container, api) {
    container.innerHTML = `
      <div class="panel rt-heading"><div><span class="eyebrow">LIVE PERFORMANCE</span><h1>リアルタイム演出パッド</h1><p class="hint">画面のボタンとキーボードで同じ操作ができます。操作すると曲の本番送信から手動操作へ切り替わります。</p></div><span id="rtConnection" class="badge">接続中…</span></div>
      <div class="panel rt-target"><label>操作対象 <select id="rtGroup" aria-label="リアルタイムの操作対象"><option value="all">全クラス [0]</option><option value="1組">1組 [1]</option><option value="2組">2組 [2]</option><option value="3組">3組 [3]</option><option value="4組">4組 [4]</option></select></label><label><input id="rtKeyboard" type="checkbox" checked> キーボード操作を有効にする</label><button id="rtStop" class="danger">■ 全クラス停止・暗転 <kbd>Esc</kbd></button><div id="rtGroupButtons" class="rt-group-buttons" role="group" aria-label="対象クラスのボタン"></div></div>
      <div class="rt-columns"><div class="panel"><div class="section-heading"><h2>画面カラー</h2><span class="muted">Q〜O</span></div><div id="rtColors" class="rt-pads"></div><div class="row"><label>好きな色 <input id="rtCustom" type="color" value="#ff8800" aria-label="リアルタイムの好きな色"></label><button id="rtSendColor">この色を送信</button></div></div>
      <div class="panel"><div class="section-heading"><h2>背面ライト</h2><span class="muted">H / J / K / L / Space</span></div><div class="rt-torch-pads"><button id="rtOn">✦ 点灯 <kbd>H</kbd></button><button id="rtOff">消灯 <kbd>J</kbd></button><button id="rtPulse">一定間隔で点滅 <kbd>K</kbd></button><button id="rtRamp">徐々に間隔を変更 <kbd>L</kbd></button><button id="rtFlash" class="rt-flash">一瞬だけ点灯 <kbd>Space</kbd></button></div><div class="rt-fields"><label>開始／一定間隔（秒）<input id="rtInterval" type="number" min="0.05" max="2" step="0.05" value="1"></label><label>終了間隔（秒）<input id="rtIntervalEnd" type="number" min="0.05" max="2" step="0.05" value="0.2"></label><label>変化にかける時間（秒）<input id="rtRampDuration" type="number" min="0.1" max="120" step="0.1" value="5"></label></div><p class="hint">間隔は点灯と消灯を切り替える時間です。例：1秒 → 0.2秒を5秒かけて加速。変化が終わると終了間隔で点滅を続けます。終了間隔を大きくすると減速します。</p></div></div>
      <div class="panel"><div class="section-heading"><h2>会場の現在の演出</h2><span id="rtStatus" class="muted">停止中</span></div><div id="rtPhones" class="phones"></div><p class="hint">対象クラスは数字の0〜4でも選べます。入力欄の編集中、キーの長押し、ほかの画面ではショートカットは動きません。</p></div>`;
    const el = id => container.querySelector('#' + id);
    let active = false;
    const phones = LightShow.groups.map(group => {
      const phone = document.createElement('div'); phone.className = 'rt-phone';
      const torch = document.createElement('span'); torch.className = 'torch';
      const label = document.createElement('span'); label.className = 'phone-label'; label.textContent = group;
      phone.append(torch, label); el('rtPhones').append(phone); return { group, phone, torch };
    });
    function feedback(button) {
      button?.classList.add('rt-pressed');
      setTimeout(() => button?.classList.remove('rt-pressed'), 160);
    }
    async function send(channel, mode, extra, button) {
      if (!active) return;
      try {
        await api.send({ channel, mode, group: el('rtGroup').value, ...extra });
        feedback(button); api.notify(`${el('rtGroup').selectedOptions[0].textContent} に演出を送信しました。`);
      } catch (error) { api.notify(error.message, true); }
    }
    ['all', ...LightShow.groups].forEach((group, index) => {
      const button = document.createElement('button'); button.dataset.group = group; button.textContent = `${group === 'all' ? '全クラス' : group} [${index}]`;
      button.onclick = () => { el('rtGroup').value = group; }; el('rtGroupButtons').append(button);
    });
    const shortcuts = new Map();
    const colors = [
      ['赤', '#ff0055', 'Q'], ['青', '#0088ff', 'W'], ['黄', '#ffd000', 'E'], ['緑', '#00cc44', 'R'],
      ['紫', '#9900ff', 'T'], ['ピンク', '#ff66cc', 'Y'], ['白', '#ffffff', 'U'], ['画面暗転', '#000000', 'I'], ['虹色', 'rainbow', 'O']
    ];
    colors.forEach(([name, color, key]) => {
      const button = document.createElement('button'); button.dataset.color = color;
      button.append(document.createTextNode(name + ' ')); const kbd = document.createElement('kbd'); kbd.textContent = key; button.append(kbd);
      button.style.background = color === 'rainbow' ? 'linear-gradient(100deg,#b53c64,#6959b3,#398b72)' : color;
      button.style.color = ['#ffffff', '#ffd000', '#ff66cc'].includes(color) ? '#111' : '#fff';
      button.onclick = () => send('screen', color === 'rainbow' ? 'rainbow' : 'color', { color }, button);
      el('rtColors').append(button); shortcuts.set('Key' + key, () => button.click());
    });
    el('rtSendColor').onclick = () => send('screen', 'color', { color: el('rtCustom').value }, el('rtSendColor'));
    function interval(id, min, max) {
      const n = Number(el(id).value);
      if (!Number.isFinite(n) || n < min || n > max) { el(id).focus(); throw new Error(`${min}〜${max}の範囲で設定してください`); }
      return n;
    }
    function torch(mode, button) {
      let extra = {};
      try {
        if (mode === 'pulse' || mode === 'ramp') extra.interval = interval('rtInterval', 0.05, 2) * 1000;
        if (mode === 'ramp') { extra.intervalEnd = interval('rtIntervalEnd', 0.05, 2) * 1000; extra.rampDuration = interval('rtRampDuration', 0.1, 120); }
      } catch (error) { return api.notify(error.message, true); }
      return send('torch', mode, extra, button);
    }
    [['rtOn', 'on', 'KeyH'], ['rtOff', 'off', 'KeyJ'], ['rtPulse', 'pulse', 'KeyK'], ['rtRamp', 'ramp', 'KeyL'], ['rtFlash', 'flash', 'Space']].forEach(([id, mode, code]) => {
      el(id).onclick = () => torch(mode, el(id)); shortcuts.set(code, () => el(id).click());
    });
    el('rtStop').onclick = () => api.stop(); shortcuts.set('Escape', () => el('rtStop').click());
    function keydown(event) {
      if (!active || !el('rtKeyboard').checked || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable],dialog')) return;
      if (event.repeat) { if (shortcuts.has(event.code) || /^(?:Digit|Numpad)[0-4]$/.test(event.code)) event.preventDefault(); return; }
      const digit = /^(?:Digit|Numpad)([0-4])$/.exec(event.code);
      if (digit) { event.preventDefault(); el('rtGroup').value = digit[1] === '0' ? 'all' : digit[1] + '組'; return; }
      const action = shortcuts.get(event.code);
      if (action) { event.preventDefault(); action(); }
    }
    document.addEventListener('keydown', keydown);
    function render() {
      if (!active) return;
      const { show, now, connected } = api.getState();
      el('rtConnection').textContent = connected ? '● 接続済み' : '切断中';
      el('rtStatus').textContent = !show ? '停止中' : show.songId === '__realtime__' ? 'リアルタイム操作中' : `${show.title} · ${show.playing ? '再生中' : '一時停止中'}`;
      phones.forEach(({ phone, torch, group }) => {
        const running = show && !(show.playing && now < show.startTime);
        const state = LightShow.stateAt(running ? show.cues : [], running ? LightShow.position(show, now) : 0, group);
        phone.style.backgroundColor = state.color; torch.classList.toggle('on', state.torch);
      });
      el('rtGroupButtons').querySelectorAll('button').forEach(button => { const selected = button.dataset.group === el('rtGroup').value; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
      container.querySelectorAll('button').forEach(button => { button.disabled = !connected; });
    }
    return { setActive(value) { active = value; render(); }, render };
  }
  root.LightRealtime = { mount };
})(globalThis);

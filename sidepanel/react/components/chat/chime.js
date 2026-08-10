// chime.js — the attention chime, panel.js:571-603.
//
// CONTRACT-V6 §6. A run that stops to ask is a run doing nothing until the user
// notices. Synthesized, not a bundled asset: no new permission, no file, works
// offline. Only ever for a stop that WAITS ON A HUMAN — a chime on ordinary
// progress is noise the user learns to ignore, which defeats the point.
//
// The AudioContext is module scope, exactly as it was in panel.js. It is a browser
// resource rather than UI state, it must survive every re-render, and a second one
// would be a second set of hardware buffers for no benefit — so it deliberately does
// NOT become a ref inside ChatView.

let audioCtx = null;

/**
 * @param {object|null} settings  the live settings object; the chime is opt-in via
 *                                settings.soundOnPrompt and silent without it.
 */
export function chime(settings) {
  if (!settings || !settings.soundOnPrompt) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx || new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    // Two rising notes — distinct from a system alert, and short enough not to nag.
    [[880, 0], [1174.7, 0.14]].forEach(([freq, at]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.18, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.22);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.24);
    });
  } catch {
    // Audio is a nicety. It must never take a run down.
  }
}

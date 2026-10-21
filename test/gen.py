# Synthetic test sounds for Rotor Ear's detector + fingerprint classifier. Writes test/wav/*.wav
import numpy as np, wave, os
SR = 48000; T = 12; t = np.arange(SR * T) / SR; rng = np.random.default_rng(7)
os.makedirs(os.path.join(os.path.dirname(__file__), 'wav'), exist_ok=True)
def save(name, x):
    m = np.max(np.abs(x)); x = x / m * 0.6 if m > 0.01 else x
    w = wave.open(os.path.join(os.path.dirname(__file__), 'wav', name + '.wav'), 'wb')
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((x * 32767).astype(np.int16).tobytes()); w.close()
def comb(f_inst, n, tilt, amps=None):
    ph = 2 * np.pi * np.cumsum(f_inst) / SR
    return sum((amps[h - 1] if amps is not None else 1) * np.sin(h * ph + rng.uniform(0, 6)) * h ** -tilt for h in range(1, n + 1))
def wobble(rate, depth): return 1 + depth * np.sin(2 * np.pi * rate * t + rng.uniform(0, 6))
noise = lambda: rng.standard_normal(len(t))
def rpm_walk(depth):  # slow random RPM wander (relative), ~0.1-1 Hz
    k = rng.standard_normal(T * 20).cumsum(); k = (k - k.mean()) / (np.abs(k).max() + 1e-9) * depth
    return np.interp(t, np.linspace(0, T, len(k)), k)
def quad(f0, n=25, tilt=0.8, detune=(0, 0.014, -0.011, 0.023), nz=0.2):
    x = sum(comb(f0 * (1 + d) * wobble(0.2 + 0.15 * i, 0.004) * (1 + rpm_walk(0.006)), n, tilt) for i, d in enumerate(detune))
    return x / np.max(np.abs(x)) + nz * noise()
save('quad', quad(175))
save('quad_hi', quad(290))
# fixed-wing / single prop fly-by: one comb, slow Doppler glide 131 -> 119 Hz, loudness swell
fw = 125 * (1 - 0.05 * np.tanh((t - 6) / 2.5)) * (1 + rpm_walk(0.002))
x = comb(fw, 30, 0.9) * (0.5 + 0.5 * np.exp(-((t - 6) / 4) ** 2)); save('fixed', x / np.max(np.abs(x)) + 0.2 * noise())
# micro / toy drone: high whiny rotors, fast-decaying harmonics
save('toy', quad(530, n=14, tilt=1.6, detune=(0, 0.02, -0.015, 0.03), nz=0.15))
# fan / AC: rock-steady blade-pass comb + airflow whoosh
x = comb(np.full_like(t, 140.0), 10, 1.3); save('fan', x / np.max(np.abs(x)) + 0.35 * noise())
# mains / transformer hum: 50 Hz and its multiples
amps = np.array([0.3, 1, 0.5, 0.6, 0.3, 0.4, 0.2, 0.25, 0.15, 0.2] + [0.1] * 20)
x = comb(np.full_like(t, 50.0), 30, 0.3, amps); save('mains', x / np.max(np.abs(x)) + 0.1 * noise())
# engine idle: ~38 Hz firing rate, irregular (fast jitter), harmonics fluctuating
fj = 38 * (1 + 0.03 * np.interp(t, np.linspace(0, T, T * 40), rng.standard_normal(T * 40)))
x = comb(fj, 60, 0.6) * (1 + 0.3 * np.interp(t, np.linspace(0, T, T * 15), rng.standard_normal(T * 15)))
save('engine', x / np.max(np.abs(x)) + 0.2 * noise())
# motorbike / generator: ~62 Hz firing, irregular
fj = 62 * (1 + 0.025 * np.interp(t, np.linspace(0, T, T * 40), rng.standard_normal(T * 40)))
x = comb(fj, 60, 0.5) * (1 + 0.3 * np.interp(t, np.linspace(0, T, T * 15), rng.standard_normal(T * 15)))
save('moto', x / np.max(np.abs(x)) + 0.2 * noise())
# --- Teach-mode cases: sounds the hand-set profiles get wrong. *_teach and *_test are different
# recordings (different seed, pitch, detune) of the same kind of thing.
def hexa(f0, seed):
    r = np.random.default_rng(seed)  # heavy-lift hexacopter: 6 tightly matched big rotors, low pitch, little beating
    det = r.uniform(-0.0025, 0.0025, 6)
    x = sum(comb(f0 * (1 + d) * (1 + 0.0004 * np.sin(2 * np.pi * r.uniform(0.1, 0.3) * t)), 25, 0.9) for d in det)
    return x / np.max(np.abs(x)) + 0.15 * noise()
save('hexa_teach', hexa(104, 11)); save('hexa_test', hexa(98, 12))
def boxfans(f0, seed):
    r = np.random.default_rng(seed)  # two 5-blade box fans on one table (~120 Hz blade-pass): detuned combs beat like rotors, plus turbulence
    x = sum(comb(np.full_like(t, f0 * (1 + d)), 12, 1.1) for d in (0, r.uniform(0.012, 0.02)))
    x *= 1 + 0.25 * np.interp(t, np.linspace(0, T, T * 8), r.standard_normal(T * 8))
    return x / np.max(np.abs(x)) + 0.3 * noise()
save('boxfans_teach', boxfans(118, 21)); save('boxfans_test', boxfans(125, 22))
# negatives carried over from the first Rotor Ear tests
save('tone', np.sin(2 * np.pi * 1000 * t))
save('white', noise())
save('silence', np.zeros_like(t))
f0 = 140 + 40 * np.sin(2 * np.pi * 0.7 * t) + 25 * np.sin(2 * np.pi * 2.3 * t)
env = np.clip(np.sin(2 * np.pi * 3.8 * t + np.sin(2 * np.pi * 0.5 * t)), 0, 1) ** 1.5 * (np.sin(2 * np.pi * 0.25 * t) > -0.6)
save('speech', comb(f0, 30, 1.2) * env + 0.05 * noise())
print('wrote', sorted(os.listdir(os.path.join(os.path.dirname(__file__), 'wav'))))

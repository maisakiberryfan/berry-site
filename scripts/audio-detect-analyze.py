# 音訊偵測批次分析器 — 變化點法（PoC v4 驗證參數）
# flagged/nohistory: 偵測結束點（music→talk − 14s 偏移）
# outlier: 雙端偵測（start: talk→music；end: music→talk），|偏差|>30s 判該端可疑
# 輸出: e:/tmp/audio_batch/detect_results.json + detect_report.txt
import json, os
import numpy as np
from scipy.io import wavfile
from scipy.signal import medfilt

DIR = 'e:/tmp/audio_batch'
ENV_HOP = 0.05
WIN = 2.0
K = 50                    # 對比窗 25s
END_OFFSET_FULL = 14.0    # 完整版：尾奏漸弱＋掌聲過渡（PoC 校正）
END_OFFSET_SHORT = 3.0    # 短版（<150s）：收尾快直接講話（用戶實聽校正 2026-07-05）
SHORT_TH = 150            # 演唱長度分界
SUSPECT_TH = 30           # outlier 裁決門檻

def end_offset(sung_dur):
    return END_OFFSET_SHORT if sung_dur < SHORT_TH else END_OFFSET_FULL

def envelope(path):
    sr, y = wavfile.read(path)
    if y.dtype != np.float32:
        y = y.astype(np.float32) / np.iinfo(y.dtype).max
    if y.ndim > 1:
        y = y.mean(axis=1)
    n = int(sr * ENV_HOP)
    m = len(y) // n
    if m < 100:
        return None
    return np.sqrt((y[:m * n].reshape(m, n) ** 2).mean(axis=1))

def speech_series(env):
    fps = int(1 / ENV_HOP)
    wlen = int(WIN * fps)
    whop = int(0.5 * fps)
    times, scores = [], []
    for start in range(0, len(env) - wlen, whop):
        w = env[start:start + wlen]
        peak = w.max() + 1e-9
        pause = (w < peak * 0.15).mean()
        wd = w - w.mean()
        spec = np.abs(np.fft.rfft(wd * np.hanning(len(wd)))) ** 2
        freqs = np.fft.rfftfreq(len(wd), d=ENV_HOP)
        band = spec[(freqs >= 3) & (freqs <= 6)].sum()
        total = spec[(freqs >= 0.5) & (freqs <= 10)].sum() + 1e-12
        cv = w.std() / (w.mean() + 1e-9)
        scores.append(pause + band / total + min(cv, 2.0) * 0.5)
        times.append((start + wlen / 2) * ENV_HOP)
    return np.array(times), medfilt(np.array(scores), 5)

def change_point(t, s, direction, lo=None, hi=None):
    """direction=+1: music→talk (右-左 max)；-1: talk→music。lo/hi 限制搜尋範圍（秒）"""
    n = len(s)
    if n < 20:
        return None, 0.0
    best_k, best_c = None, -1e9
    for k in range(4, n - 4):
        if lo is not None and t[k] < lo: continue
        if hi is not None and t[k] > hi: continue
        left = s[max(0, k - K):k]
        right = s[k:k + K]
        if len(left) < 6 or len(right) < 6: continue
        c = (right.mean() - left.mean()) * direction
        if c > best_c:
            best_c, best_k = c, k
    if best_k is None:
        return None, 0.0
    return t[best_k], best_c

def main():
    batch = json.load(open(f'{DIR}/batch.json', encoding='utf-8'))
    results = []
    n_ok = 0
    for b in batch:
        path = f"{DIR}/{b['id']}.wav"
        r = dict(b)
        if not os.path.exists(path):
            r.update(status='no_audio')
            results.append(r)
            continue
        env = envelope(path)
        if env is None:
            r.update(status='too_short')
            results.append(r)
            continue
        t, s = speech_series(env)
        w0 = b['windowStart']
        if b['kind'] in ('flagged', 'nohistory'):
            rel, conf = change_point(t, s, +1)
            if rel is None:
                r.update(status='no_cp')
            else:
                raw = w0 + rel
                det = raw - end_offset(raw - b['startTime'])
                r.update(status='ok', detectedEnd=round(det, 1), conf=round(conf, 3),
                         suggestedEnd=int(round(det)))
                # 守衛：不得超過 nextStart、不得早於 start+40
                if b.get('nextStart') and r['suggestedEnd'] > b['nextStart']:
                    r['suggestedEnd'] = b['nextStart']
                    r['capped'] = 'nextStart'
                if r['suggestedEnd'] < b['startTime'] + 40:
                    r.update(status='implausible')
                n_ok += 1
        else:  # outlier 雙端
            mid = (b['startTime'] + b['recEnd']) / 2 - w0
            relS, confS = change_point(t, s, -1, hi=mid)          # talk→music 在前半
            relE, confE = change_point(t, s, +1, lo=mid)          # music→talk 在後半
            detS = w0 + relS if relS is not None else None
            detE = None
            if relE is not None:
                rawE = w0 + relE
                base = detS if detS is not None else b['startTime']
                detE = rawE - end_offset(rawE - base)
            dS = round(detS - b['startTime'], 1) if detS is not None else None
            dE = round(detE - b['recEnd'], 1) if detE is not None else None
            verdict = []
            if dS is not None and abs(dS) > SUSPECT_TH: verdict.append(f'start可疑({dS:+.0f}s)')
            if dE is not None and abs(dE) > SUSPECT_TH: verdict.append(f'end可疑({dE:+.0f}s)')
            r.update(status='ok', detStart=detS and round(detS, 1), detEnd=detE and round(detE, 1),
                     startDiff=dS, endDiff=dE, confS=round(confS, 3), confE=round(confE, 3),
                     verdict=' '.join(verdict) if verdict else '兩端吻合')
            n_ok += 1
        results.append(r)

    json.dump(results, open(f'{DIR}/detect_results.json', 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)

    # 報告
    out = [f'音訊偵測批次結果 — {len(results)} 筆（分析成功 {n_ok}）', '=' * 80]
    for kind, title in [('flagged', 'flagged（缺end撞下一首）'), ('nohistory', '無歷史（缺end）'), ('outlier', 'outlier 裁決')]:
        rows = [r for r in results if r['kind'] == kind]
        okr = [r for r in rows if r['status'] == 'ok']
        out.append(f'\n【{title}】 {len(okr)}/{len(rows)} 偵測成功')
        out.append('-' * 80)
        for r in rows:
            base = f"  {r['id']:34s} {str(r.get('songName',''))[:20]:20s}"
            if r['status'] != 'ok':
                out.append(base + f'  [{r["status"]}]')
            elif kind == 'outlier':
                out.append(base + f"  start{r['startDiff']:+.0f}s end{r['endDiff']:+.0f}s → {r['verdict']}"
                           if r['startDiff'] is not None and r['endDiff'] is not None
                           else base + f"  {r['verdict']}")
            else:
                cap = f" (cap:{r['capped']})" if r.get('capped') else ''
                out.append(base + f"  est={r.get('est')}s → detected={r['suggestedEnd'] - r['startTime']}s"
                                  f" end={r['suggestedEnd']}{cap} conf={r['conf']}")
    open(f'{DIR}/detect_report.txt', 'w', encoding='utf-8').write('\n'.join(out))
    print('\n'.join(out[:6]))
    print(f'\nSaved {DIR}/detect_results.json, detect_report.txt')

if __name__ == '__main__':
    main()

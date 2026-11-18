#!/usr/bin/env python3
"""Build assets/library-rhythms.json from rhythms.txt (the djembeloops export).

The app loads the compact file at startup and turns each entry into a playable rhythm (see
ensureLibraryRhythmsLoaded in app.js). Run again whenever rhythms.txt changes:

    python3 scripts/build-library-rhythms.py

Compact format, per rhythm:
    k   key            n   name           t   tempo        s   steps per cycle
    sw  swing          d   description    tags
    r   rows: {instrumentPrefix: one character per step}   c   call (signal) pattern, same encoding
    o   origin: [place label, country, lat, lng, how it was found]
Step characters: '.' rest, O open, S slap, B bass, M muffled; flams and rolls use the letters in CODES.
"""
import hashlib
import json
import math
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'rhythms.txt')
OUT = os.path.join(ROOT, 'assets', 'library-rhythms.json')

CODES = {
    None: '.', 'Open': 'O', 'Slap': 'S', 'Bass': 'B', 'Muffled': 'M',
    'OpenFlam': 'a', 'SlapFlam': 'c', 'BassFlam': 'k', 'SlapBassFlam': 'd', 'BassOpenFlam': 'e',
    'OpenRoll': 'f', 'OpenBassFlam': 'g', 'BassSlapFlam': 'h', 'SlapRoll': 'i', 'BassRoll': 'j',
    'OpenSlapFlam': 'l', 'SlapOpenFlam': 'n',
}

# Places named in the descriptions, most specific first: (pattern, label, country, lat, lng, spread in degrees)
PLACES = [
    (r'kouroussa', 'Kouroussa', 'Guinea', 10.65, -9.88, 0.35),
    (r'faranah', 'Faranah', 'Guinea', 10.04, -10.74, 0.35),
    (r'kankan', 'Kankan', 'Guinea', 10.39, -9.31, 0.35),
    (r'siguiri', 'Siguiri', 'Guinea', 11.42, -9.17, 0.35),
    (r'hamana', 'Hamana', 'Guinea', 10.45, -9.55, 0.35),
    (r'wassolo', 'Wassolon', 'Guinea', 11.0, -8.6, 0.45),
    (r'casamance', 'Casamance', 'Senegal', 12.6, -16.3, 0.35),
    (r'sousou|susu|baga', 'Coastal Guinea', 'Guinea', 9.8, -13.4, 0.4),
    (r'baoul|senufo|senoufo|dioula', 'Ivory Coast', 'Ivory Coast', 7.7, -5.2, 0.9),
    (r'bobo', 'Bobo-Dioulasso', 'Burkina Faso', 11.18, -4.3, 0.4),
]
COUNTRIES = [
    (r'ivory coast|c[oô]te d.ivoire', 'Ivory Coast', 'Ivory Coast', 7.7, -5.2, 1.0),
    (r'senegal', 'Senegal', 'Senegal', 14.4, -16.2, 0.9),
    (r'gambia', 'Gambia', 'Gambia', 13.4, -16.0, 0.4),
    (r'burkina', 'Burkina Faso', 'Burkina Faso', 12.0, -1.8, 1.0),
    (r'\bmali\b|bambara', 'Mali', 'Mali', 12.9, -7.6, 1.0),
    (r'guin[eé]e?a?\b|guinea', 'Guinea', 'Guinea', 10.6, -10.4, 1.0),
    (r'malink|mandingue|maninka', 'Mandé region', 'Guinea', 11.0, -9.4, 1.0),
]
DEFAULT = ('West Africa', 'West Africa', 11.3, -9.8, 1.4)


def jitter(key, spread):
    """Fixed per-rhythm offset so dots near the same place don't sit on top of each other."""
    h = hashlib.sha1(key.encode()).digest()
    a = (h[0] / 255) * 2 * math.pi
    r = math.sqrt(h[1] / 255) * spread
    return r * math.sin(a), r * math.cos(a)


def origin(entry):
    text = f"{entry.get('footer') or ''} {entry.get('info') or ''}".lower()
    best = None
    for table, how in ((PLACES, 'place'), (COUNTRIES, 'country')):
        for pat, label, country, lat, lng, spread in table:
            m = re.search(pat, text)
            # Places win over countries; among countries, the one mentioned first wins.
            if m and (best is None or (how == best[0] and m.start() < best[1])):
                best = (how, m.start(), label, country, lat, lng, spread)
        if best and best[0] == 'place':
            break
    if best:
        _, _, label, country, lat, lng, spread = best
        how = best[0]
    else:
        label, country, lat, lng, spread = DEFAULT
        how = 'unknown'
    dlat, dlng = jitter(entry['key'], spread)
    place = label if label == country or how == 'unknown' else f'{label}, {country}'
    return [place, country, round(lat + dlat, 4), round(lng + dlng, 4), how]


def encode(steps, length):
    out = []
    for i in range(length):
        v = steps[i] if i < len(steps) else None
        out.append(CODES.get(v, '.'))
    return ''.join(out)


def main():
    data = json.load(open(SRC, encoding='utf-8'))
    rhythms = []
    unknown_values = set()
    skipped = {'templates': 0, 'exercises': 0}
    for e in data.get('rhythms', []):
        rows = e.get('rows') or []
        key = str(e.get('key') or '')
        # Not rhythms: blank "Compose your rhythm" grids and the practice exercises (Threes in Fours, ...).
        if key.startswith('startTable') or not any(v for r in rows for v in (r.get('steps') or [])):
            skipped['templates'] += 1
            continue
        if key.startswith('practise'):
            skipped['exercises'] += 1
            continue
        row_len = max((len(r.get('steps') or []) for r in rows), default=0)
        steps = int(e.get('steps') or 0)
        if steps <= 0 or steps > 64:          # some exports store e.g. 4812 for 48-step rows
            steps = row_len or 16
        for r in rows:
            for v in r.get('steps') or []:
                if v not in CODES:
                    unknown_values.add(v)
        sig = (e.get('signal') or {}).get('pattern') or []
        rhythms.append({
            'k': e['key'], 'n': e.get('name') or e['key'], 't': e.get('tempo') or 100, 's': steps,
            'sw': e.get('swing') or {}, 'd': (e.get('footer') or e.get('info') or '').strip(),
            'tags': [t for t in (e.get('tags') or []) if isinstance(t, str) and t.strip()],
            'r': {r['instrumentPrefix']: encode(r.get('steps') or [], steps) for r in rows if r.get('instrumentPrefix')},
            'c': encode(sig, len(sig)) if sig else '',
            'o': origin(e),
        })
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    payload = {'source': 'djembeloops', 'exportedAt': data.get('meta', {}).get('exportedAt'), 'codes': {v: k for k, v in CODES.items() if k}, 'rhythms': rhythms}
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    by = {}
    for r in rhythms:
        by[r['o'][4]] = by.get(r['o'][4], 0) + 1
    print(f'{len(rhythms)} rhythms -> {os.path.relpath(OUT, ROOT)} ({os.path.getsize(OUT) // 1024} KB); origin from {by}; left out {skipped}')
    if unknown_values:
        print('step values not encoded (treated as rests):', sorted(map(str, unknown_values)))


if __name__ == '__main__':
    main()
